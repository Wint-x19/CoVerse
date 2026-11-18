"""Build the two independently annotated story specimens in each verified writer shape."""
import hashlib
import json
import sqlite3
import sys
from pathlib import Path
from uuid import UUID
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools/fixtures"))
import runpy
wire = runpy.run_path(str(ROOT / "tools/fixtures/create-antigravity.py"))
field, integer = wire["field"], wire["integer"]
cases = json.loads((Path(__file__).with_name("cases-v1.json")).read_text())["seeds"]
for agent in ("codex", "claude-code", "antigravity"):
    folder = ROOT / "fixtures" / agent / "m31-v1"
    folder.mkdir(parents=True, exist_ok=True)
    files = []
    for seed, case in cases.items():
        sid = str(UUID(int=int(seed)))
        history = case["history"]
        name = folder / ("seed-" + seed + (".db" if agent == "antigravity" else ".jsonl"))
        if agent == "antigravity":
            with sqlite3.connect(ROOT / "fixtures/antigravity/sqlite-2_32_1-step0/sample.db") as base, sqlite3.connect(name) as db:
                base.backup(db)
                db.execute("DELETE FROM steps")
                db.execute("UPDATE trajectory_meta SET trajectory_id=?,cascade_id=?", (sid,sid))
                for index,(role,text) in enumerate(history):
                    kind, tag, part = (14,19,2) if role=="user" else (15,20,1)
                    payload = integer(1,kind)+integer(4,3)+field(tag,field(part,text))
                    db.execute("INSERT INTO steps(idx,step_type,status,step_payload) VALUES(?,?,3,?)",(index,kind,payload))
        else:
            rows = []
            parent = None
            if agent == "codex":
                rows.append(dict(type="session_meta",payload=dict(id=sid,cli_version="0.169.0-alpha.11.1",cwd="/sample/workspace")))
            for i,(role,text) in enumerate(history):
                if agent=="codex":
                    rows.append(dict(type="response_item",payload=dict(type="message",role=role,content=[dict(type="input_text" if role=="user" else "output_text",text=text)])))
                else:
                    uid = str(UUID(int=int(seed)*100+i))
                    rows.append(dict(type=role,uuid=uid,parentUuid=parent,sessionId=sid,version="2.1.121",cwd="/sample/workspace",message=dict(role=role,content=text if role=="user" else [dict(type="text",text=text)])))
                    parent = uid
            name.write_bytes(("".join(json.dumps(r)+"\n" for r in rows)).encode())
        files.append(dict(path=name.name,format=name.suffix[1:],sha256=hashlib.sha256(name.read_bytes()).hexdigest()))
    manifest=dict(schemaVersion=1,agent=agent,formatVersion="m31-v1",provenance="reconstructed",reviewRequired=False,nativeFormatVerified=True,description="Two invented shipping histories with independent semantic oracles.",evidence=["Reuses the native writer subset documented by the corresponding M2 adapter. Semantic data authored specifically for M3.1."],files=files)
    (folder/"manifest.json").write_bytes((json.dumps(manifest,indent=2)+"\n").encode())
