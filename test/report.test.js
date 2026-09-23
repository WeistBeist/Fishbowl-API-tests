"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { encodePacket, readPacket } = require("../lib/packet");
const {
  assertSelectOnly,
  parseCsvLine,
  rowsFromCsvLines,
  rowsFromXml,
  rowsFromJson,
  classifyLoginFailure,
  escapeXml,
} = require("../lib/parse");

const root = path.join(__dirname, "..");

test("saved queries are select statements and match the html report", () => {
  const saved = JSON.parse(fs.readFileSync(path.join(root, "saved-queries.json"), "utf8"));
  const html = fs.readFileSync(path.join(root, "Fishbowl-Query-Report.html"), "utf8");
  const embedded = html.match(/<script type="application\/json" id="saved-queries-data">([\s\S]*?)<\/script>/);
  assert.ok(embedded, "embedded saved queries");
  assert.deepEqual(JSON.parse(embedded[1]), saved);
  assert.equal(saved.length, 5);
  for (const query of saved) {
    assert.equal(assertSelectOnly(query.sql), query.sql);
  }
});

test("query guard accepts a trailing semicolon and comments", () => {
  assert.equal(assertSelectOnly("-- note\nSELECT id FROM company;"), "-- note\nSELECT id FROM company;");
  assert.equal(assertSelectOnly("WITH cte AS (SELECT 1 AS id) SELECT id FROM cte"), "WITH cte AS (SELECT 1 AS id) SELECT id FROM cte");
});

test("query guard rejects writes and stacked statements", () => {
  for (const sql of [
    "DELETE FROM company",
    "SELECT 1; DELETE FROM company",
    "UPDATE company SET name = 'x'",
    "SELECT * FROM company INTO OUTFILE '/tmp/x'",
    "DROP TABLE company",
  ]) {
    assert.throws(() => assertSelectOnly(sql), /SELECT/);
  }
});

test("query guard allows the word update inside a string", () => {
  const sql = "SELECT id, name FROM company WHERE name = 'update'";
  assert.equal(assertSelectOnly(sql), sql);
});

test("csv and xml query results become records", () => {
  assert.deepEqual(parseCsvLine('"US","United, States"'), ["US", "United, States"]);
  const csv = rowsFromCsvLines(["id,name", "1,United States", '2,"A, B"']);
  assert.deepEqual(csv.columns, ["id", "name"]);
  assert.equal(csv.records[1].name, "A, B");

  const xml = rowsFromXml(`<FbiXml><ExecuteQueryRs statusCode="1000"><Rows>
    <Row>id,abbreviation,name</Row>
    <Row>1,US,United States</Row>
  </Rows></ExecuteQueryRs></FbiXml>`);
  assert.equal(xml.records[0].abbreviation, "US");

  const elements = rowsFromXml("<Rows><Row><id>4</id><name>Each</name></Row></Rows>");
  assert.deepEqual(elements.records[0], { id: "4", name: "Each" });
  assert.deepEqual(rowsFromJson([{ id: 1, name: "Acme" }]).records[0], { id: 1, name: "Acme" });
});

test("login failures distinguish approval from a bad password", () => {
  assert.equal(
    classifyLoginFailure(401, "This integrated application has not been approved by the Fishbowl administrator.", {}),
    "approval"
  );
  assert.equal(classifyLoginFailure("1110", "", {}), "approval");
  assert.equal(classifyLoginFailure(401, "Invalid username or password.", {}), "auth");
  assert.equal(classifyLoginFailure(401, "", { mfa: "Required" }), "mfa");
});

test("xml escape covers password and query characters", () => {
  assert.equal(escapeXml(`a<b>&"c`), "a&lt;b&gt;&amp;&quot;c");
});

test("legacy packets survive a split read", async () => {
  const payload = "<FbiXml><FbiMsgsRs statusCode=\"1110\"/></FbiXml>";
  const encoded = encodePacket(payload);
  assert.equal(encoded.readUInt32BE(0), Buffer.byteLength(payload));
  const socket = new EventEmitter();
  const pending = readPacket(socket, 1000);
  socket.emit("data", encoded.subarray(0, 3));
  socket.emit("data", encoded.subarray(3, 6));
  socket.emit("data", encoded.subarray(6));
  assert.equal(await pending, payload);
});
