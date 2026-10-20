"""Fetch selected subtrees of a ServiceNow docs (Fluid Topics KHUB) map as Markdown.

Endpoints were discovered by REA browser capture d01-change-mgmt-doc:
  GET /docs/api/khub/maps/{map}/toc
  GET /docs/api/khub/maps/{map}/topics/{contentId}/content?target=DESIGNED_READER

usage: python3 -I fetch_docs.py <map_id> <out_dir> <subtree title>[,<subtree title>...] [--max-depth N]
A subtree title of "*" selects the whole map.
"""
import json
import os
import re
import sys
import time
import html
import threading
import queue
import urllib.request
from html.parser import HTMLParser

BASE = "https://www.servicenow.com/docs/api/khub/maps/"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36")


def get(url, accept="application/json", tries=4):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001 - retry any transport error
            if attempt == tries - 1:
                raise
            time.sleep(2 * (attempt + 1))


class MD(HTMLParser):
    """Small HTML -> Markdown converter covering what DITA topics use."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.list_stack = []
        self.in_table = False
        self.row = None
        self.cell = None
        self.rows = []
        self.skip = 0
        self.pre = False
        self.href = None

    def w(self, s):
        if self.cell is not None:
            self.cell.append(s)
        else:
            self.out.append(s)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get("class", "") or ""
        if tag in ("script", "style", "svg", "button"):
            self.skip += 1
            return
        if self.skip:
            return
        if re.fullmatch(r"h[1-6]", tag):
            self.w("\n\n" + "#" * int(tag[1]) + " ")
        elif tag in ("p", "div", "section", "dd"):
            self.w("\n\n")
        elif tag == "dt":
            self.w("\n\n**")
        elif tag == "br":
            self.w("\n")
        elif tag in ("ul", "ol"):
            self.list_stack.append([tag, 0])
            self.w("\n")
        elif tag == "li":
            depth = max(len(self.list_stack) - 1, 0)
            if self.list_stack and self.list_stack[-1][0] == "ol":
                self.list_stack[-1][1] += 1
                bullet = f"{self.list_stack[-1][1]}."
            else:
                bullet = "-"
            self.w("\n" + "  " * depth + bullet + " ")
        elif tag in ("strong", "b"):
            self.w("**")
        elif tag in ("em", "i"):
            self.w("*")
        elif tag in ("code", "kbd", "samp", "var"):
            if not self.pre:
                self.w("`")
        elif tag == "pre":
            self.pre = True
            self.w("\n\n```\n")
        elif tag == "table":
            self.in_table = True
            self.rows = []
        elif tag == "tr" and self.in_table:
            self.row = []
        elif tag in ("td", "th") and self.in_table:
            self.cell = []
        elif tag == "img":
            alt = a.get("alt")
            if alt:
                self.w(f"[image: {alt}]")
        elif tag == "a":
            self.href = a.get("href")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "svg", "button"):
            self.skip = max(self.skip - 1, 0)
            return
        if self.skip:
            return
        if tag in ("strong", "b"):
            self.w("**")
        elif tag == "dt":
            self.w("**")
        elif tag in ("em", "i"):
            self.w("*")
        elif tag in ("code", "kbd", "samp", "var"):
            if not self.pre:
                self.w("`")
        elif tag == "pre":
            self.pre = False
            self.w("\n```\n")
        elif tag in ("ul", "ol"):
            if self.list_stack:
                self.list_stack.pop()
            self.w("\n")
        elif tag in ("td", "th") and self.cell is not None:
            txt = re.sub(r"\s+", " ", "".join(self.cell)).strip().replace("|", "\\|")
            if self.row is not None:
                self.row.append(txt)
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.rows.append(self.row)
            self.row = None
        elif tag == "table":
            self.in_table = False
            if self.rows:
                width = max(len(r) for r in self.rows)
                lines = []
                for i, r in enumerate(self.rows):
                    r = r + [""] * (width - len(r))
                    lines.append("| " + " | ".join(r) + " |")
                    if i == 0:
                        lines.append("|" + "---|" * width)
                self.out.append("\n\n" + "\n".join(lines) + "\n\n")
            self.rows = []

    def handle_data(self, data):
        if self.skip:
            return
        if self.pre:
            self.w(data)
        else:
            self.w(re.sub(r"\s+", " ", data))

    def markdown(self):
        s = "".join(self.out)
        s = re.sub(r"\n{3,}", "\n\n", s)
        s = re.sub(r"[ \t]+\n", "\n", s)
        return s.strip() + "\n"


def to_md(h):
    p = MD()
    p.feed(h)
    return p.markdown()


def slug(s):
    s = re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-")
    return s[:80] or "untitled"


def main():
    map_id, out_dir, titles = sys.argv[1], sys.argv[2], sys.argv[3].split(",")
    max_depth = 99
    if "--max-depth" in sys.argv:
        max_depth = int(sys.argv[sys.argv.index("--max-depth") + 1])
    os.makedirs(out_dir, exist_ok=True)
    toc_path = os.path.join(out_dir, "_toc.json")
    if os.path.exists(toc_path):
        toc = json.load(open(toc_path))
    else:
        toc = json.loads(get(BASE + map_id + "/toc"))
        json.dump(toc, open(toc_path, "w"))

    jobs = []

    def collect(node, path, depth):
        jobs.append((node, path))
        if depth < max_depth:
            for i, c in enumerate(node.get("children", [])):
                collect(c, path + [f"{i:03d}-{slug(c['title'])}"], depth + 1)

    def find(nodes, want):
        # breadth-first so the shallowest (canonical) section wins over same-named sub-sections
        frontier = list(nodes)
        while frontier:
            nxt = []
            for n in frontier:
                if want == "*" or n["title"] == want:
                    yield n
                nxt.extend(n.get("children", []))
            frontier = nxt

    def find_path(nodes, spec):
        parts = [x.strip() for x in spec.split("/")]
        cur = nodes
        hit = None
        for part in parts:
            hit = next(find(cur, part), None)
            if hit is None:
                return []
            cur = hit.get("children", [])
        return [hit]

    for t in titles:
        hits = find_path(toc, t.strip())
        if not hits:
            print("NOT FOUND:", t, file=sys.stderr)
        for n in hits[:1]:
            collect(n, [slug(n["title"])], 0)

    q = queue.Queue()
    for j in jobs:
        q.put(j)
    index = []
    lock = threading.Lock()

    def worker():
        while True:
            try:
                node, path = q.get_nowait()
            except queue.Empty:
                return
            fn = os.path.join(out_dir, *path[:-1], path[-1] + ".md") if node.get("children") is None or True else None
            dirn = os.path.dirname(fn)
            os.makedirs(dirn, exist_ok=True)
            url_pretty = "https://www.servicenow.com/docs" + (node.get("prettyUrl") or "")
            if not os.path.exists(fn):
                try:
                    h = get(BASE + map_id + "/topics/" + node["contentId"] + "/content?target=DESIGNED_READER",
                            accept="text/html")
                    md = to_md(h)
                except Exception as e:  # noqa: BLE001
                    md = f"FETCH FAILED: {e}\n"
                with open(fn, "w") as f:
                    f.write(f"<!-- source: {url_pretty} -->\n\n{md}")
                time.sleep(0.35)
            with lock:
                index.append({"title": node["title"], "file": os.path.relpath(fn, out_dir), "url": url_pretty})

    threads = [threading.Thread(target=worker) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    index.sort(key=lambda x: x["file"])
    idx_path = os.path.join(out_dir, "_index.json")
    old = json.load(open(idx_path)) if os.path.exists(idx_path) else []
    seen = {x["file"] for x in index}
    merged = index + [x for x in old if x["file"] not in seen]
    json.dump(merged, open(idx_path, "w"), indent=1)
    print(f"fetched {len(index)} topics into {out_dir}")


if __name__ == "__main__":
    main()
