"""Builds extra.svg: the whole of src/page.html inside one SVG foreignObject, with no separate page."""
import html.entities
import re
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BOOLEAN = "hidden|disabled|checked|required|selected|multiple|allowfullscreen|autofocus|open|readonly|novalidate|formnovalidate|defer|async"
VOID = "area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr"


def entity(match):
    code = html.entities.name2codepoint.get(match.group(1))
    return "&#%d;" % code if code and match.group(1) not in ("amp", "lt", "gt", "quot", "apos") else match.group(0)


def tag(match):
    text = re.sub(r"(\s(?:%s))(?=[\s/>])(?!=)" % BOOLEAN, r'\1=""', match.group(0))
    if re.match(r"<(%s)\b" % VOID, text) and not text.endswith("/>"):
        text = text[:-1] + " />"
    return text


def xhtml(text):
    text = re.sub(r"<[a-zA-Z][^<>]*>", tag, text)
    text = re.sub(r"&([a-zA-Z]+);", entity, text)
    return text.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"')


def build():
    page = (ROOT / "src" / "page.html").read_text(encoding="utf-8")
    page = re.sub(r"<!--.*?-->", "", page, flags=re.S)
    head = re.search(r"<head>(.*?)</head>", page, re.S).group(1)
    head = re.sub(r"<meta[^>]*charset[^>]*>|<title>.*?</title>|<script type=\"module\".*?</script>", "", head, flags=re.S)
    body = re.search(r"<body[^>]*>.*</body>", page, re.S).group(0)
    shim = (ROOT / "src" / "svgshim.js").read_text(encoding="utf-8")
    picture = (ROOT / "src" / "decoy.svg").read_text(encoding="utf-8")
    view_box = re.search(r'viewBox="([^"]+)"', picture).group(1)
    picture = re.search(r"<g\b.*</g>", picture, re.S).group(0)
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="100%%" height="100%%" style="position:fixed;inset:0">\n'
        "<title>extra.svg</title>\n"
        '<svg id="decoy" x="30%%" y="30%%" width="40%%" height="40%%" viewBox="%s">%s</svg>\n'
        '<foreignObject width="100%%" height="100%%">\n'
        '<html xmlns="http://www.w3.org/1999/xhtml">\n<head>\n<script><![CDATA[\n%s]]></script>\n%s\n</head>\n%s\n</html>\n'
        "</foreignObject>\n</svg>\n" % (view_box, picture, shim, xhtml(head), xhtml(body))
    )
    out = ROOT / "extra.svg"
    if not out.exists() or out.read_text(encoding="utf-8") != svg:  # unchanged keeps its date, so it isn't re-uploaded
        out.write_text(svg, encoding="utf-8", newline="\n")
    ET.fromstring(svg.encode("utf-8"))  # a browser shows an error page for anything that isn't valid XML
    return svg


if __name__ == "__main__":
    print("extra.svg", len(build()), "chars")
