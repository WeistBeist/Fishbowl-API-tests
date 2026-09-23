"use strict";

const MAX_ROWS = 1000;

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripSqlComments(sql) {
  let s = String(sql ?? "").replace(/^\uFEFF/, "");
  let prev;
  do {
    prev = s;
    s = s.replace(/^\s+/, "");
    s = s.replace(/^--[^\n]*(\n|$)/, "");
    s = s.replace(/^\/\*[\s\S]*?\*\//, "");
  } while (s !== prev);
  return s;
}

function maskSqlStrings(sql) {
  return sql.replace(/'(?:''|[^'])*'/g, "''");
}

function assertSelectOnly(sql) {
  const original = String(sql ?? "");
  if (!original.trim()) {
    throw new Error("Enter a SQL query.");
  }
  if (original.length > 20000) {
    throw new Error("Query is too long.");
  }
  const stripped = stripSqlComments(original);
  if (!/^(select|with)\b/i.test(stripped)) {
    throw new Error("Only a single SELECT query can be run.");
  }
  const masked = maskSqlStrings(stripped);
  const parts = masked.split(";").map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) {
    throw new Error("Only a single SELECT query can be run.");
  }
  if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|replace|call|merge|into|outfile|load_file|attach|detach)\b/i.test(masked)) {
    throw new Error("Only a read-only SELECT query can be run.");
  }
  return original.trim();
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  const text = String(line ?? "");
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function rowsFromCsvLines(lines) {
  const parsed = lines.map((line) => parseCsvLine(decodeXml(line)));
  if (!parsed.length) return { columns: [], records: [], total: 0, truncated: false };
  const columns = parsed[0].map((name, index) => name || `column_${index + 1}`);
  const records = parsed.slice(1).map((values) => {
    const row = {};
    columns.forEach((column, index) => {
      row[column] = values[index] ?? "";
    });
    return row;
  });
  return capRows(columns, records);
}

function rowsFromXml(xml) {
  const rows = [];
  const re = /<Row\b[^>]*>([\s\S]*?)<\/Row>|<Row\b[^>]*\/>/g;
  let match;
  while ((match = re.exec(xml))) {
    const inner = match[1] ?? "";
    if (/<[A-Za-z_]/.test(inner)) {
      const record = {};
      const child = /<([A-Za-z_][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
      let item;
      while ((item = child.exec(inner))) {
        record[item[1]] = decodeXml(item[2].trim());
      }
      rows.push(record);
    } else {
      rows.push(decodeXml(inner.trim()));
    }
  }
  if (!rows.length) return { columns: [], records: [], total: 0, truncated: false };
  if (typeof rows[0] === "string") return rowsFromCsvLines(rows);
  const columns = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  return capRows(columns, rows);
}

function rowsFromJson(data) {
  let rows = data;
  if (rows && typeof rows === "object" && !Array.isArray(rows)) {
    if (Array.isArray(rows.results)) rows = rows.results;
    else if (Array.isArray(rows.Rows)) rows = rows.Rows;
    else if (Array.isArray(rows.rows)) rows = rows.rows;
    else if (Array.isArray(rows.data)) rows = rows.data;
  }
  if (!Array.isArray(rows)) {
    throw new Error("Fishbowl returned a result that is not a row list.");
  }
  if (!rows.length) return { columns: [], records: [], total: 0, truncated: false };
  if (typeof rows[0] !== "object" || rows[0] === null || Array.isArray(rows[0])) {
    return capRows(
      ["value"],
      rows.map((value) => ({ value: value == null ? "" : String(value) }))
    );
  }
  const columns = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  const records = rows.map((row) => {
    const record = {};
    for (const column of columns) {
      const value = row ? row[column] : "";
      if (value == null) record[column] = "";
      else if (typeof value === "object") record[column] = JSON.stringify(value);
      else record[column] = value;
    }
    return record;
  });
  return capRows(columns, records);
}

function capRows(columns, records) {
  const total = records.length;
  const truncated = total > MAX_ROWS;
  return {
    columns,
    records: truncated ? records.slice(0, MAX_ROWS) : records,
    total,
    truncated,
  };
}

function xmlAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}\\b([^>]*)\\/?>`, "i");
  const match = xml.match(re);
  if (!match) return "";
  const found = match[1].match(new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return found ? decodeXml(found[1] ?? found[2] ?? "") : "";
}

function ticketKey(xml) {
  const match = xml.match(/<Key>([\s\S]*?)<\/Key>/i);
  return match ? decodeXml(match[1].trim()) : "";
}

function isApprovalMessage(message) {
  return /not been approved|has been added to fishbowl|approve this integrated application/i.test(message || "");
}

function classifyLoginFailure(status, message, headers) {
  const mfa = headers && (headers.mfa || headers["mfa"]);
  if (String(mfa || "").toLowerCase() === "required") return "mfa";
  if (isApprovalMessage(message) || status === "1110" || status === "1112") return "approval";
  if (Number(status) === 401 || status === "1120") return "auth";
  return "error";
}

function errorText(body, fallback) {
  if (!body) return fallback;
  try {
    const data = JSON.parse(body);
    return data.message || data.detail || data.statusMessage || fallback;
  } catch {
    const text = String(body).replace(/\s+/g, " ").trim();
    return text.slice(0, 500) || fallback;
  }
}

module.exports = {
  MAX_ROWS,
  escapeXml,
  decodeXml,
  assertSelectOnly,
  parseCsvLine,
  rowsFromCsvLines,
  rowsFromXml,
  rowsFromJson,
  xmlAttr,
  ticketKey,
  isApprovalMessage,
  classifyLoginFailure,
  errorText,
};
