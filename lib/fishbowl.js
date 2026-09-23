"use strict";

const crypto = require("crypto");
const http = require("http");
const net = require("net");
const { encodePacket, readPacket } = require("./packet");
const {
  escapeXml,
  assertSelectOnly,
  rowsFromXml,
  rowsFromJson,
  xmlAttr,
  ticketKey,
  classifyLoginFailure,
  isApprovalMessage,
  errorText,
} = require("./parse");

const STATUS_TEXT = {
  1000: "Success",
  1001: "Unknown message received",
  1002: "Connection to Fishbowl Server was lost",
  1003: "Some requests had errors",
  1004: "There was an error with the database",
  1009: "Fishbowl Server has been shut down",
  1010: "You have been logged off the server by an administrator",
  1012: "Unknown request function",
  1100: "Unknown login error",
  1110: "This integrated application has not been approved by the Fishbowl administrator.",
  1111: "This integrated application registration key does not match.",
  1112: "This integrated application has not been approved by the Fishbowl administrator.",
  1120: "Invalid username or password.",
  1130: "Invalid ticket passed to Fishbowl Server.",
  1162: "The login limit has been reached for the server key.",
};

function statusText(code, fallback) {
  return STATUS_TEXT[String(code)] || fallback || `Fishbowl returned status ${code}.`;
}

function requiredConfig(env = process.env) {
  const missing = ["ServerHost", "UserName", "UserPassword", "AppId", "AppName", "AppDesc"].filter(
    (name) => !env[name]
  );
  return {
    host: env.ServerHost || "",
    legacyPort: Number(env.ServerPort || 28192),
    webPort: Number(env.WebPort || env.FishbowlWebPort || 2456),
    username: env.UserName || "",
    password: env.UserPassword || "",
    appId: env.AppId || "",
    appName: env.AppName || "",
    appDesc: env.AppDesc || "",
    missing,
  };
}

function httpRequest({ host, port, method, path, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        method,
        path,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) {
            req.destroy(new Error("Fishbowl response is too large. Add a LIMIT clause."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("Timed out waiting for Fishbowl."));
    });
    if (body) req.write(body);
    req.end();
  });
}

class FishbowlClient {
  constructor(config) {
    this.config = config;
    this.token = null;
    this.profile = null;
    this.transport = null;
    this.socket = null;
    this.legacyKey = null;
    this.queue = Promise.resolve();
  }

  lock(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  status(mfaCode) {
    return this.lock(() => this._status(mfaCode));
  }

  query(sql, mfaCode) {
    return this.lock(async () => {
      const checked = assertSelectOnly(sql);
      const login = await this._ensure(mfaCode);
      if (!login.ok) return login;
      const started = Date.now();
      try {
        const table =
          this.transport === "legacy" ? await this._legacyQuery(checked) : await this._restQuery(checked);
        return {
          ok: true,
          columns: table.columns,
          records: table.records,
          rowCount: table.total,
          truncated: table.truncated,
          elapsedMs: Date.now() - started,
          transport: this.transport,
        };
      } catch (error) {
        if (error && error.code === "approval") {
          this.token = null;
          return this.failure("approval", error.message);
        }
        return {
          ok: false,
          code: "query",
          message: error.message || "The query failed.",
          transport: this.transport,
        };
      }
    });
  }

  async close() {
    if (this.token && this.transport === "rest") {
      try {
        await httpRequest({
          host: this.config.host,
          port: this.config.webPort,
          method: "POST",
          path: "/api/logout",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Length": 0,
            Connection: "close",
          },
          timeoutMs: 5000,
        });
      } catch {
        // The report is closing; a missed logout expires on the server.
      }
    }
    this.token = null;
    this.legacyKey = null;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  failure(code, message) {
    return {
      ok: false,
      code,
      message,
      appName: this.config.appName,
      transport: this.transport,
      webPort: this.config.webPort,
      legacyPort: this.config.legacyPort,
    };
  }

  successStatus() {
    return {
      ok: true,
      code: "connected",
      message: "Signed in to Fishbowl.",
      appName: this.config.appName,
      user: this.profile?.user || "",
      serverVersion: this.profile?.serverVersion || "",
      transport: this.transport,
      webPort: this.config.webPort,
      legacyPort: this.config.legacyPort,
    };
  }

  async _status(mfaCode) {
    if (this.config.missing.length) {
      return this.failure(
        "config",
        `Missing environment variables: ${this.config.missing.join(", ")}.`
      );
    }
    if (this.transport === "rest" && this.token && !mfaCode) return this.successStatus();
    if (this.transport === "legacy" && this.legacyKey && !mfaCode) return this.successStatus();
    return this._login(mfaCode);
  }

  async _ensure(mfaCode) {
    if (!mfaCode && this.transport === "rest" && this.token) return { ok: true };
    if (!mfaCode && this.transport === "legacy" && this.legacyKey && this.socket && !this.socket.destroyed) {
      return { ok: true };
    }
    return this._login(mfaCode);
  }

  async _login(mfaCode) {
    if (this.config.missing.length) {
      return this.failure(
        "config",
        `Missing environment variables: ${this.config.missing.join(", ")}.`
      );
    }
    const rest = await this._restLogin(mfaCode);
    if (rest.reachable) return rest.result;
    return this._legacyLogin();
  }

  async _restLogin(mfaCode) {
    const payload = {
      appName: this.config.appName,
      appDescription: this.config.appDesc,
      appId: /^\d+$/.test(this.config.appId) ? Number(this.config.appId) : this.config.appId,
      username: this.config.username,
      password: this.config.password,
    };
    if (mfaCode) payload.mfaCode = String(mfaCode).trim();
    const body = JSON.stringify(payload);
    let response;
    try {
      response = await httpRequest({
        host: this.config.host,
        port: this.config.webPort,
        method: "POST",
        path: "/api/login",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(body),
          Connection: "close",
        },
        body,
        timeoutMs: 20000,
      });
    } catch (error) {
      const code = error.code || "";
      if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "EAI_AGAIN", "ETIMEDOUT"].includes(code)) {
        return { reachable: false };
      }
      if (/timed out/i.test(error.message || "")) return { reachable: false };
      return {
        reachable: true,
        result: this.failure("network", error.message || "Could not reach the Fishbowl web port."),
      };
    }

    let data = {};
    try {
      data = response.body ? JSON.parse(response.body) : {};
    } catch {
      data = {};
    }
    const message = data.message || data.detail || errorText(response.body, "");
    if (response.status >= 200 && response.status < 300) {
      const token = data.token || data.sessionToken || "";
      if (!token) {
        return {
          reachable: true,
          result: this.failure("error", "Fishbowl login succeeded without a session token."),
        };
      }
      this.transport = "rest";
      this.token = token;
      const user = data.user || {};
      this.profile = {
        user: user.userFullName || user.fullName || "",
        serverVersion: user.serverVersion || data.serverVersion || "",
      };
      this.legacyKey = null;
      return { reachable: true, result: this.successStatus() };
    }

    const code = classifyLoginFailure(response.status, message, response.headers);
    this.token = null;
    this.transport = "rest";
    return {
      reachable: true,
      result: this.failure(code, message || statusText(response.status, "Login failed.")),
    };
  }

  async _restQuery(sql, retried) {
    const response = await httpRequest({
      host: this.config.host,
      port: this.config.webPort,
      method: "GET",
      path: "/api/data-query",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/sql",
        Accept: "application/json",
        "Content-Length": Buffer.byteLength(sql),
        Connection: "close",
      },
      body: sql,
      timeoutMs: 60000,
    });
    if (response.status === 401 && !retried) {
      this.token = null;
      const login = await this._login();
      if (!login.ok) {
        const error = new Error(login.message);
        error.code = login.code;
        throw error;
      }
      return this._restQuery(sql, true);
    }
    if (response.status < 200 || response.status >= 300) {
      const message = errorText(response.body, `Query failed (${response.status}).`);
      const error = new Error(message);
      if (isApprovalMessage(message)) error.code = "approval";
      throw error;
    }
    let data;
    try {
      data = JSON.parse(response.body || "[]");
    } catch {
      throw new Error("Fishbowl returned a query result that is not JSON.");
    }
    return rowsFromJson(data);
  }

  connectLegacy() {
    return new Promise((resolve, reject) => {
      const socket = net.connect({
        host: this.config.host,
        port: this.config.legacyPort,
      });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Timed out connecting to the Fishbowl legacy port."));
      }, 15000);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.setTimeout(60000);
        resolve(socket);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async sendLegacy(xml) {
    if (!this.socket || this.socket.destroyed) {
      this.socket = await this.connectLegacy();
      this.legacyKey = null;
    }
    const pending = readPacket(this.socket);
    this.socket.write(encodePacket(xml));
    return pending;
  }

  legacyLoginXml() {
    const password = crypto.createHash("md5").update(this.config.password, "utf8").digest("base64");
    return `<FbiXml><Ticket><Key></Key></Ticket><FbiMsgsRq><LoginRq><IAID>${escapeXml(
      this.config.appId
    )}</IAID><IAName>${escapeXml(this.config.appName)}</IAName><IADescription>${escapeXml(
      this.config.appDesc
    )}</IADescription><UserName>${escapeXml(this.config.username)}</UserName><UserPassword>${escapeXml(
      password
    )}</UserPassword></LoginRq></FbiMsgsRq></FbiXml>`;
  }

  async _legacyLogin() {
    try {
      if (this.socket) {
        this.socket.destroy();
        this.socket = null;
      }
      this.socket = await this.connectLegacy();
      const xml = await this.sendLegacy(this.legacyLoginXml());
      const code = xmlAttr(xml, "LoginRs", "statusCode") || xmlAttr(xml, "FbiMsgsRs", "statusCode");
      const message =
        xmlAttr(xml, "LoginRs", "statusMessage") ||
        xmlAttr(xml, "FbiMsgsRs", "statusMessage") ||
        statusText(code, "Login failed.");
      const key = ticketKey(xml);
      if (code === "1000" && key && key !== "null") {
        this.transport = "legacy";
        this.legacyKey = key;
        this.token = null;
        this.profile = { user: "", serverVersion: "" };
        return this.successStatus();
      }
      this.legacyKey = null;
      this.transport = "legacy";
      if (this.socket) {
        this.socket.destroy();
        this.socket = null;
      }
      const kind = classifyLoginFailure(code, message, {});
      return this.failure(kind, message);
    } catch (error) {
      this.transport = "legacy";
      return this.failure("network", error.message || "Could not reach Fishbowl.");
    }
  }

  async _legacyQuery(sql) {
    const xml = `<FbiXml><Ticket><Key>${escapeXml(
      this.legacyKey
    )}</Key></Ticket><FbiMsgsRq><ExecuteQueryRq><Query>${escapeXml(
      sql
    )}</Query></ExecuteQueryRq></FbiMsgsRq></FbiXml>`;
    const response = await this.sendLegacy(xml);
    const code =
      xmlAttr(response, "ExecuteQueryRs", "statusCode") || xmlAttr(response, "FbiMsgsRs", "statusCode");
    if (code !== "1000") {
      const message =
        xmlAttr(response, "ExecuteQueryRs", "statusMessage") ||
        xmlAttr(response, "FbiMsgsRs", "statusMessage") ||
        statusText(code, "Query failed.");
      const error = new Error(message);
      if (code === "1130" || code === "1010") {
        this.legacyKey = null;
      }
      throw error;
    }
    return rowsFromXml(response);
  }
}

module.exports = {
  FishbowlClient,
  requiredConfig,
  httpRequest,
};
