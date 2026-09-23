"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { FishbowlClient, requiredConfig } = require("./lib/fishbowl");
const { assertSelectOnly } = require("./lib/parse");

const root = __dirname;
const reportPath = path.join(root, "Fishbowl-Query-Report.html");
const savedPath = path.join(root, "saved-queries.json");
const port = Number(process.env.REPORT_PORT || 8787);
const config = requiredConfig(process.env);
const client = new FishbowlClient(config);

function savedQueries() {
  const data = JSON.parse(fs.readFileSync(savedPath, "utf8"));
  return data.map((query) => ({
    name: String(query.name),
    sql: assertSelectOnly(query.sql),
  }));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(Object.assign(new Error("Request is too large."), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, payload, type) {
  const body = type === "html" ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": type === "html" ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
  });
  res.end(body);
}

function publicError(error) {
  const message = error && error.message ? error.message : "Request failed.";
  return { ok: false, code: "error", message };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (req.method === "OPTIONS") {
      send(res, 204, "");
      return;
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/Fishbowl-Query-Report.html")) {
      send(res, 200, fs.readFileSync(reportPath), "html");
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/saved") {
      send(res, 200, savedQueries());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      send(res, 200, await client.status(url.searchParams.get("mfaCode") || ""));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/session") {
      const body = JSON.parse((await readBody(req, 4000)) || "{}");
      send(res, 200, await client.status(body.mfaCode || ""));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/query") {
      const body = JSON.parse((await readBody(req, 100000)) || "{}");
      let sql;
      try {
        sql = assertSelectOnly(body.sql || "");
      } catch (error) {
        send(res, 400, { ok: false, code: "sql", message: error.message });
        return;
      }
      const result = await client.query(sql, body.mfaCode || "");
      const status = result.ok ? 200 : result.code === "approval" ? 403 : 400;
      if (result.ok) {
        console.log(`query ok rows=${result.rowCount} ms=${result.elapsedMs} via=${result.transport}`);
      } else {
        console.log(`query ${result.code || "error"}`);
      }
      send(res, status, result);
      return;
    }
    send(res, 404, { ok: false, message: "Not found." });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status === 500) console.error(error.message);
    send(res, status, publicError(error));
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Open http://127.0.0.1:${port}/`);
    process.exit(1);
  }
  console.error(error.message);
  process.exit(1);
});

function shutdown() {
  server.close();
  client.close().finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (require.main === module) {
  server.listen(port, "127.0.0.1", () => {
    console.log(`Fishbowl query report: http://127.0.0.1:${port}/`);
    console.log("Leave this process running while the report is open.");
  });
}

module.exports = { server, client, savedQueries };
