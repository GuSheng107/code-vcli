from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
FONT_REGULAR = Path("C:/Windows/Fonts/segoeui.ttf")
FONT_BOLD = Path("C:/Windows/Fonts/segoeuib.ttf")


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    preferred = FONT_BOLD if bold else FONT_REGULAR
    if preferred.exists():
        return ImageFont.truetype(str(preferred), size)
    return ImageFont.truetype("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf", size)


def rounded(draw: ImageDraw.ImageDraw, box, fill, radius=18, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def make_web() -> None:
    img = Image.new("RGB", (1440, 1000), "#f5f7fb")
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, 250, 1000), fill="#111827")
    d.text((36, 34), "NORTHSTAR", fill="#ffffff", font=font(28, True))
    d.text((36, 70), "ANALYTICS", fill="#94a3b8", font=font(14, True))
    nav = ["Dashboard", "Reports", "Customers", "Invoices", "Settings"]
    for i, label in enumerate(nav):
        y = 145 + i * 66
        if i == 0:
            rounded(d, (22, y - 12, 228, y + 36), "#2563eb", 12)
        d.text((48, y), label, fill="#ffffff" if i == 0 else "#cbd5e1", font=font(19, i == 0))

    d.text((298, 44), "Quarterly Overview", fill="#111827", font=font(34, True))
    d.text((298, 91), "Q3 performance across all customer segments", fill="#64748b", font=font(17))
    rounded(d, (1190, 42, 1385, 94), "#2563eb", 12)
    d.text((1232, 58), "Export CSV", fill="#ffffff", font=font(18, True))

    cards = [
        ("Quarterly Revenue", "$482,610", "+18.4%", "#2563eb"),
        ("Active Accounts", "1,284", "+63 this month", "#7c3aed"),
        ("Conversion Rate", "7.6%", "+1.2 points", "#059669"),
    ]
    for i, (title, value, delta, accent) in enumerate(cards):
        x = 298 + i * 358
        rounded(d, (x, 140, x + 322, 300), "#ffffff", 18, "#e2e8f0")
        d.rectangle((x, 140, x + 7, 300), fill=accent)
        d.text((x + 28, 168), title, fill="#64748b", font=font(17, True))
        d.text((x + 28, 208), value, fill="#111827", font=font(34, True))
        d.text((x + 28, 260), delta, fill="#059669", font=font(15, True))

    rounded(d, (298, 330, 1385, 400), "#fff7ed", 14, "#fdba74")
    d.text((330, 352), "Attention: 3 invoices need review before Friday.", fill="#9a3412", font=font(20, True))
    rounded(d, (298, 430, 1385, 930), "#ffffff", 18, "#e2e8f0")
    d.text((330, 462), "Top customer accounts", fill="#111827", font=font(24, True))
    d.text((330, 505), "CUSTOMER", fill="#64748b", font=font(14, True))
    d.text((720, 505), "PLAN", fill="#64748b", font=font(14, True))
    d.text((1080, 505), "REVENUE", fill="#64748b", font=font(14, True))
    rows = [
        ("Aurora Labs", "Enterprise", "$82,400"),
        ("Blue Harbor", "Growth", "$31,250"),
        ("Cedar Works", "Starter", "$12,980"),
        ("Delta Health", "Enterprise", "$76,100"),
    ]
    for i, row in enumerate(rows):
        y = 552 + i * 78
        d.line((330, y - 15, 1350, y - 15), fill="#e2e8f0", width=2)
        d.text((330, y), row[0], fill="#0f172a", font=font(19, True))
        d.text((720, y), row[1], fill="#334155", font=font(18))
        d.text((1080, y), row[2], fill="#0f172a", font=font(19, True))
    img.save(ROOT / "web-dashboard.png", optimize=True)


def make_document() -> None:
    img = Image.new("RGB", (1240, 1754), "#e5e7eb")
    d = ImageDraw.Draw(img)
    d.rectangle((85, 55, 1155, 1699), fill="#ffffff")
    d.rectangle((85, 55, 1155, 74), fill="#1d4ed8")
    d.text((145, 125), "PROJECT ORION", fill="#111827", font=font(42, True))
    d.text((145, 182), "RELEASE MEMO", fill="#2563eb", font=font(24, True))
    d.line((145, 235, 1095, 235), fill="#cbd5e1", width=2)
    d.text((145, 270), "Date", fill="#64748b", font=font(17, True))
    d.text((330, 270), "August 6, 2026", fill="#111827", font=font(18))
    d.text((145, 310), "Owner", fill="#64748b", font=font(17, True))
    d.text((330, 310), "Mei Lin", fill="#111827", font=font(18))
    d.text((145, 350), "Status", fill="#64748b", font=font(17, True))
    d.text((330, 350), "Approved for implementation", fill="#047857", font=font(18, True))

    y = 425
    sections = [
        ("OBJECTIVE", [
            "Launch a fully local visual inspection workflow for web pages and documents.",
            "No screenshots or extracted text may leave the workstation.",
        ]),
        ("DECISIONS", [
            "1. CPU OCR remains the default path for low-memory systems.",
            "2. GPU Mix runs OCR first, releases its memory, then loads the VLM.",
            "3. Use the AWQ model on 16 GB GPUs unless the user chooses otherwise.",
        ]),
        ("SUCCESS METRICS", [
            "- Identify the primary page intent and all visible actions.",
            "- Recover dates, owners, totals, and warning messages from documents.",
            "- Keep every inference local and produce reusable JSON output.",
        ]),
        ("RISKS", [
            "High-resolution images can exhaust VRAM during VLM preprocessing.",
            "Mitigation: resize only when required and preserve the original aspect ratio.",
        ]),
        ("ACTION ITEMS", [
            "Mei Lin — finish GPU Mix implementation — August 8",
            "Owen Park — validate web dashboard understanding — August 9",
            "Sara Kim — validate release memo understanding — August 9",
        ]),
    ]
    for title, lines in sections:
        d.text((145, y), title, fill="#1d4ed8", font=font(20, True))
        y += 48
        for line in lines:
            d.text((165, y), line, fill="#1f2937", font=font(18))
            y += 38
        y += 32
    d.line((145, 1585, 1095, 1585), fill="#cbd5e1", width=2)
    d.text((145, 1620), "Confidential — internal use only", fill="#64748b", font=font(15))
    d.text((1010, 1620), "1 / 1", fill="#64748b", font=font(15))
    img.save(ROOT / "release-memo.png", optimize=True)


if __name__ == "__main__":
    make_web()
    make_document()
    print(ROOT / "web-dashboard.png")
    print(ROOT / "release-memo.png")
