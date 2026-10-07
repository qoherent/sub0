import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "subzero-sqlite-smoke-"));
const file = join(directory, "metadata.db");
let db = new DatabaseSync(file, { timeout: 1000 });
let mode;
try {
	mode = db.prepare("PRAGMA journal_mode=WAL").get().journal_mode;
	db.exec("CREATE TABLE item (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
	db.exec("BEGIN IMMEDIATE");
	try {
		db.prepare("INSERT INTO item(value) VALUES (?)").run("persisted");
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
	db.close();
	db = new DatabaseSync(file, { timeout: 1000 });
	const rows = db.prepare("SELECT id, value FROM item").all();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].id, 1);
	assert.equal(rows[0].value, "persisted");
	console.log(JSON.stringify({ node: process.version, journal: mode, rows }));
} finally {
	try { db.close(); } catch {}
	rmSync(directory, { recursive: true, force: true });
}
