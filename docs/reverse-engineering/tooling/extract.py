import json, sys, base64, os
ev_path, out = sys.argv[1], sys.argv[2]
d = json.load(open(ev_path))
nr = d["normalized_result"]
step = nr["steps"][-1]
arts = step["artifacts"]
acc = arts.get("accessibility", {})
txt = acc.get("value", {}).get("text", "") if acc.get("state") == "captured" else ""
open(os.path.join(out, "accessibility.txt"), "w").write(txt)
shot = arts.get("screenshot", {})
if shot.get("state") == "captured":
    v = shot["value"]
    b64 = v.get("data_base64") or v.get("png_base64") or v.get("base64")
    if b64:
        open(os.path.join(out, "screenshot.png"), "wb").write(base64.b64decode(b64))
    else:
        open(os.path.join(out, "screenshot-keys.txt"), "w").write(",".join(v.keys()))
reqs = [e for e in nr["events"]["items"] if e["kind"] == "response"]
with open(os.path.join(out, "network.tsv"), "w") as f:
    for e in reqs:
        f.write(f"{e.get('status')}\t{e.get('resource_type')}\t{e.get('method')}\t{(e.get('url') or {}).get('url')}\n")
print(json.dumps({"evidence_id": d["evidence_id"], "final_url": step["after_url"]["url"], "status": step["status"],
                  "accessibility_bytes": len(txt), "responses": len(reqs),
                  "denied": "Access Denied" in txt[:400]}))
