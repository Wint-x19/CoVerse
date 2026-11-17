"""Reconstruct a public, content-free-of-user-data SQLite golden fixture.

Python stdlib only. Encoding below is independent of the TypeScript decoder.
The field numbers were checked against the local 2.32.1 release descriptors.
Refuses to overwrite an existing fixture. Run from the repository root.
"""
from pathlib import Path
import hashlib
import json
import sqlite3

ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / "fixtures/antigravity/sqlite-2_32_1-step0"

def varint(value):
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128)
        value >>= 7
    return bytes(result + bytes([value]))

def integer(number, value):
    return varint(number << 3) + varint(value)

def field(number, value):
    if isinstance(value, str):
        value = value.encode("utf-8")
    return varint((number << 3) | 2) + varint(len(value)) + value

def main():
    DEST.mkdir(parents=True, exist_ok=True)
    filename = DEST / "sample.db"
    if filename.exists():
        raise SystemExit("Fixture exists; choose a new baseline rather than overwriting it")
    schema = [
        "CREATE TABLE trajectory_meta (trajectory_id text, cascade_id text, trajectory_type integer, source integer, PRIMARY KEY (trajectory_id))",
        "CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))",
        "CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))",
        "CREATE TABLE executor_metadata (idx integer, data blob, PRIMARY KEY (idx))",
        "CREATE TABLE parent_references (idx integer, data blob, PRIMARY KEY (idx))",
        "CREATE TABLE trajectory_metadata_blob (id text DEFAULT 'main', data blob, PRIMARY KEY (id))",
        "CREATE TABLE battle_mode_infos (idx integer, data blob, PRIMARY KEY (idx))",
    ]
    connection = sqlite3.connect(filename)
    for statement in schema:
        connection.execute(statement)
    session_id = "00000000-0000-4000-8000-000000000003"
    connection.execute("INSERT INTO trajectory_meta VALUES (?,?,?,?)", (session_id, session_id, 0, 0))
    timestamp = integer(1, 1794873600)
    metadata = field(1, timestamp)
    workspace = field(1, "file:///sample/workspace") + field(4, "sample-branch")
    connection.execute("INSERT INTO trajectory_metadata_blob VALUES (?,?)", ("main", field(1, workspace) + field(2, timestamp)))
    call = field(1, "sample-call") + field(2, "read_file") + field(3, '{"path":"example.txt"}')
    error = field(1, "A synthetic diagnostic; no user data.")
    payloads = [
        (14, 19, field(2, "Read example.txt and explain it."), metadata),
        (15, 20, field(3, "First inspect the file.") + field(7, call), metadata),
        (132, 140, field(1, field(1, "path") + field(2, "example.txt")) + field(2, field(1, "Hello from the sample.")), metadata + field(4, call)),
        (15, 20, field(1, "The file contains a greeting."), metadata),
        (101, 114, field(1, "Historical system notice."), metadata),
        (23, 30, integer(1, 0) + field(5, "The file was inspected; original history is retained."), metadata),
        (17, 24, field(3, error), metadata),
    ]
    for index, (step_type, tag, payload, meta) in enumerate(payloads):
        wire = integer(1, step_type) + integer(4, 3) + field(5, meta) + field(tag, payload)
        connection.execute("INSERT INTO steps (idx,step_type,status,has_subtrajectory,metadata,step_payload,step_format) VALUES (?,?,?,0,?,?,0)", (index, step_type, 3, meta, wire))
    connection.commit()
    assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    connection.close()
    manifest = dict(schemaVersion=1, agent="antigravity", formatVersion="sqlite-2_32_1-step0", provenance="reconstructed", reviewRequired=False, nativeFormatVerified=True,
        description="Independent SQLite/protobuf reconstruction with invented text and identifiers; verified schema, field tags and six step types from local 2.32.1 release.",
        evidence=["Read-only inspection on 2026-11-17: five stable local conversation databases, one schema, 1862 step_format=0 records, types 14/15/17/23/101/132.", "Field names and numbers checked against FileDescriptorProto embedded in the local Antigravity 2.32.1 language_server.exe: gemini_coder.Step, exa.cortex_pb and exa.codeium_common_pb. No executable code or user payload copied.", "Golden wire bytes generated independently using Python stdlib, not the production protobuf encoder."],
        files=[dict(path="sample.db", format="db", sha256=hashlib.sha256(filename.read_bytes()).hexdigest())])
    (DEST / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

if __name__ == "__main__":
    main()
