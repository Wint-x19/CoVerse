import fs from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {it,expect} from "vitest";
import {companionForUri,localArtifactPath,nativeCompanions} from "../src/companions.js";
import {wireRoot} from "../src/wire.js";

it("captures referenced walkthrough media and distinct full outputs only inside the selected native conversation",async () => {
  const tmp = path.resolve(import.meta.dirname,"../../../../.tmp");
  await fs.mkdir(tmp,{recursive:true});
  const stores = await fs.mkdtemp(path.join(tmp,"native-companions-"));
  const id = "00000000-0000-4000-8000-000000000001";
  const source = path.join(stores,"antigravity","conversations",id+".db");
  const folder = path.join(stores,"antigravity","brain",id);
  const uri = (file:string) => pathToFileURL(path.join(folder,file)).href;
  try {
    for (const dir of ["one","two"]) {
      await fs.mkdir(path.join(folder,dir),{recursive:true});
      await fs.writeFile(path.join(folder,dir,"output.txt"),dir);
    }
    await fs.writeFile(path.join(folder,"walkthrough.md"),"![Recording](clip.webm)");
    await fs.writeFile(path.join(folder,"clip.webm"),new Uint8Array([1,2]));
    await fs.writeFile(path.join(folder,"unrelated.txt"),"never requested");
    const snapshot = wireRoot.lookupType("ArtifactSnapshot");
    const encoded = snapshot.encode(snapshot.fromObject({artifact_absolute_uri:uri("walkthrough.md")})).finish();
    const steps = [{checkpoint:{artifact_snapshots:[Buffer.from(encoded).toString("base64")]}},
      ...["one/output.txt","two/output.txt","../outside.txt"].map(file => ({generic:{result:{full_output_uri:uri(file)}}}))];
    const captured = await nativeCompanions([],source,id,steps,stores);
    expect(captured.map(f => f.path).sort()).toEqual(["artifacts/clip.webm","artifacts/one/output.txt","artifacts/two/output.txt","artifacts/walkthrough.md"]);
    expect(new TextDecoder().decode(companionForUri(uri("two/output.txt"),captured)?.bytes)).toBe("two");
    expect(localArtifactPath(source,"artifacts/clip.webm",stores)).toEqual({root:folder,relative:"clip.webm"});
    expect(await nativeCompanions([],path.join(stores,"uploaded.db"),id,steps,stores)).toEqual([]);
  } finally {await fs.rm(stores,{recursive:true,force:true});}
});
