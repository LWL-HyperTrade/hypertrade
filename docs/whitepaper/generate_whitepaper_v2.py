from __future__ import annotations

from datetime import date
from xml.sax.saxutils import escape
from pathlib import Path
from typing import Iterable, List, Sequence

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.platypus import (
    CondPageBreak,
    Flowable,
    KeepTogether,
    ListFlowable,
    ListItem,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


OUT = Path(__file__).resolve().parent
PDF_PATH = OUT / "LWL_Whitepaper.pdf"
MD_PATH = OUT / "LWL_Whitepaper.md"

PAGE_W, PAGE_H = A4
MARGIN_X = 1.75 * cm
CONTENT_W = PAGE_W - 2 * MARGIN_X

# House palette (HyperTrade app colors.ts; used here as LWL print style).
NAVY = colors.HexColor("#0A0A0F")
INK = colors.HexColor("#15151E")
MUTED = colors.HexColor("#707080")
LIGHT = colors.HexColor("#F7FAFC")
PANEL = colors.HexColor("#FFFFFF")
GOLD = colors.HexColor("#5CE1E6")        # app accent.gold (teal)
GOLD_DARK = colors.HexColor("#4ABFC4")
GOLD_LIGHT = colors.HexColor("#E6FBFC")
BLUE = colors.HexColor("#3B82F6")
BLUE_LIGHT = colors.HexColor("#EAF1FF")
GREEN = colors.HexColor("#10B981")
GREEN_LIGHT = colors.HexColor("#E9F8F1")
BORDER = colors.HexColor("#D7DEE9")
RED = colors.HexColor("#F43F5E")
PURPLE = colors.HexColor("#A855F7")
PURPLE_LIGHT = colors.HexColor("#F3E8FF")

SECTION_GAP = 0.85 * cm       # gap between chapters that share a page
MIN_SPACE_BEFORE_CHAPTER = 5.2 * cm  # CondPageBreak: start chapter on fresh page if less room


def styles():
    base = getSampleStyleSheet()
    return {
        "CoverTitle": ParagraphStyle(
            "CoverTitle",
            parent=base["Title"],
            fontName="Helvetica-Bold",
            fontSize=36,
            leading=42,
            textColor=NAVY,
            alignment=TA_LEFT,
            spaceAfter=12,
        ),
        "CoverSub": ParagraphStyle(
            "CoverSub",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=16,
            leading=24,
            textColor=MUTED,
            alignment=TA_LEFT,
            spaceAfter=18,
        ),
        "Eyebrow": ParagraphStyle(
            "Eyebrow",
            parent=base["Normal"],
            fontName="Helvetica-Bold",
            fontSize=8.5,
            leading=11,
            textColor=PURPLE,
            alignment=TA_LEFT,
            uppercase=True,
            spaceAfter=6,
        ),
        "H1": ParagraphStyle(
            "H1",
            parent=base["Heading1"],
            fontName="Helvetica-Bold",
            fontSize=21,
            leading=27,
            textColor=NAVY,
            spaceBefore=4,
            spaceAfter=12,
        ),
        "ContentsHead": ParagraphStyle(
            "ContentsHead",
            parent=base["Heading1"],
            fontName="Helvetica-Bold",
            fontSize=21,
            leading=27,
            textColor=NAVY,
            spaceBefore=6,
            spaceAfter=12,
        ),
        "H2": ParagraphStyle(
            "H2",
            parent=base["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=13.5,
            leading=18,
            textColor=INK,
            spaceBefore=8,
            spaceAfter=6,
        ),
        "Body": ParagraphStyle(
            "Body",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=9.8,
            leading=14.7,
            textColor=INK,
            spaceAfter=8,
        ),
        "Small": ParagraphStyle(
            "Small",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=8.1,
            leading=11.6,
            textColor=MUTED,
            spaceAfter=4,
        ),
        "Quote": ParagraphStyle(
            "Quote",
            parent=base["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=11,
            leading=16,
            textColor=NAVY,
            spaceAfter=4,
        ),
        "TableHead": ParagraphStyle(
            "TableHead",
            parent=base["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=8.7,
            leading=11.5,
            textColor=NAVY,
        ),
        "TableBody": ParagraphStyle(
            "TableBody",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=8.35,
            leading=11.5,
            textColor=INK,
        ),
        "TOC": ParagraphStyle(
            "TOC",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=10,
            leading=17,
            textColor=INK,
        ),
        "TOCSub": ParagraphStyle(
            "TOCSub",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=9.5,
            leading=15,
            textColor=MUTED,
            leftIndent=14,
        ),
    }


S = styles()


def P(text: str, style: str = "Body") -> Paragraph:
    return Paragraph(text, S[style])


def ext_link(url: str, label: str | None = None) -> str:
    """Clickable external link for ReportLab Paragraph markup."""
    safe_url = escape(url, {"'": "&apos;", '"': "&quot;"})
    text = escape(label or url)
    return f'<a href="{safe_url}" color="#3B82F6"><u>{text}</u></a>'


# Platform branding — UR.APP in prose; keep URID / UR API as technical terms from their docs.
UR_APP = "UR.APP"
UR_DOCS_HOME = ext_link("https://docs.ur.app/", "docs.ur.app")
LWL_SITE = ext_link("https://www.lunaticwisdomlabs.com/", "lunaticwisdomlabs.com")
HT_GITHUB = ext_link("https://github.com/LWL-HyperTrade/hypertrade", "LWL-HyperTrade/hypertrade")
OC_GITHUB = ext_link("https://github.com/LWL-OrbCast/orbcast", "LWL-OrbCast/orbcast")
HT_SITE = ext_link("https://hypertrade.exchange", "hypertrade.exchange")
OC_SITE = ext_link("https://orbcast.xyz", "orbcast.xyz")


def H1(text: str) -> Paragraph:
    return P(text, "H1")


def chapter(title: str, *, style: str = "gap") -> List:
    """Consistent chapter open. style: 'body' | 'gap' | 'page' | 'smart'.

    body  — first chapter after Contents (TOC already ended with PageBreak)
    gap   — spacer + H1 when continuing on the same page
    page  — force new page (heavy diagram sections)
    smart — new page only if less than MIN_SPACE_BEFORE_CHAPTER remains
    """
    flows: List = []
    if style == "body":
        pass  # story() already PageBreak()s after TOC
    elif style == "page":
        flows.append(PageBreak())
    elif style == "smart":
        flows.append(CondPageBreak(MIN_SPACE_BEFORE_CHAPTER))
        flows.append(Spacer(1, SECTION_GAP))
    else:
        flows.append(Spacer(1, SECTION_GAP))
    flows.append(H1(title))
    return flows


def H2(text: str) -> Paragraph:
    return P(text, "H2")


def bullets(items: Iterable[str]) -> ListFlowable:
    return ListFlowable(
        [ListItem(P(i, "Body"), leftIndent=10) for i in items],
        bulletType="bullet",
        start="circle",
        bulletFontName="Helvetica",
        bulletFontSize=6,
        bulletColor=PURPLE,
        leftIndent=14,
    )


def make_table(data: Sequence[Sequence[str]], widths: Sequence[float]) -> Table:
    rows = []
    for r, row in enumerate(data):
        rows.append([P(cell, "TableHead" if r == 0 else "TableBody") for cell in row])
    t = Table(rows, colWidths=widths, hAlign="LEFT")
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), LIGHT),
                ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return t


class FeatureStrip(Flowable):
    def __init__(self, items: Sequence[tuple[str, str]], width: float = CONTENT_W):
        super().__init__()
        self.items = items
        self.width = width
        # Tall enough for two-line values without clipping. The previous
        # version used one-line values and could cut text in narrow pills.
        self.height = 2.15 * cm

    def draw(self):
        c = self.canv
        gap = 8
        w = (self.width - gap * (len(self.items) - 1)) / len(self.items)
        for i, (label, value) in enumerate(self.items):
            x = i * (w + gap)
            c.setFillColor(LIGHT)
            c.setStrokeColor(BORDER)
            c.roundRect(x, 0, w, self.height, 9, fill=1, stroke=1)
            c.setFillColor(PURPLE)
            c.setFont("Helvetica-Bold", 8)
            c.drawString(x + 9, self.height - 18, label.upper())
            c.setFillColor(NAVY)
            c.setFont("Helvetica-Bold", 10.4)
            words = value.split()
            line = ""
            lines: List[str] = []
            for word in words:
                test = (line + " " + word).strip()
                if line and stringWidth(test, "Helvetica-Bold", 10.4) > w - 18:
                    lines.append(line)
                    line = word
                else:
                    line = test
            if line:
                lines.append(line)
            for j, txt in enumerate(lines[:2]):
                c.drawString(x + 9, self.height - 39 - j * 12, txt)


class Callout(Flowable):
    PAD_X = 0.78 * cm
    PAD_Y = 0.34 * cm

    def __init__(self, text: str, width: float = CONTENT_W, tone: str = "gold"):
        super().__init__()
        self.text = text
        self.width = width
        self.tone = tone
        self.para_style = ParagraphStyle(
            "CalloutText",
            parent=S["Body"],
            fontName="Helvetica-Bold",
            textColor=NAVY,
            fontSize=9.6,
            leading=13.5,
        )
        inner_w = self.width - self.PAD_X - 0.37 * cm
        _w, text_h = Paragraph(self.text, self.para_style).wrap(inner_w, 10000)
        self.height = max(1.55 * cm, text_h + 2 * self.PAD_Y)

    def draw(self):
        c = self.canv
        fill = GOLD_LIGHT if self.tone == "gold" else BLUE_LIGHT
        stroke = GOLD_DARK if self.tone == "gold" else BLUE
        c.setFillColor(fill)
        c.setStrokeColor(stroke)
        c.roundRect(0, 0, self.width, self.height, 9, fill=1, stroke=1)
        c.setFillColor(stroke)
        c.circle(0.42 * cm, self.height / 2, 0.12 * cm, fill=1, stroke=0)
        inner_w = self.width - self.PAD_X - 0.37 * cm
        para = Paragraph(self.text, self.para_style)
        para.wrapOn(c, inner_w, self.height - 2 * self.PAD_Y)
        para.drawOn(c, self.PAD_X, self.PAD_Y)


class FlowDiagram(Flowable):
    """A controlled-width horizontal diagram with no overflowing nodes."""

    def __init__(self, title: str, nodes: Sequence[tuple[str, str]], width: float = CONTENT_W, color=GOLD):
        super().__init__()
        self.title = title
        self.nodes = nodes
        self.width = width
        self.color = color
        # Includes title + node row + bottom breathing room. Earlier value
        # understated the drawn node area, which caused diagrams to collide
        # with following content.
        self.height = 4.75 * cm

    def _wrapped(self, text: str, max_width: float, font: str, size: float) -> List[str]:
        out: List[str] = []
        cur = ""
        for word in text.split():
            test = (cur + " " + word).strip()
            if cur and stringWidth(test, font, size) > max_width:
                out.append(cur)
                cur = word
            else:
                cur = test
        if cur:
            out.append(cur)
        return out

    def draw(self):
        c = self.canv
        c.setFillColor(NAVY)
        c.setFont("Helvetica-Bold", 10.5)
        c.drawString(0, self.height - 14, self.title)
        n = len(self.nodes)
        gap = 14
        top = self.height - 48
        box_h = 64
        box_w = (self.width - gap * (n - 1)) / n
        for i, (head, body) in enumerate(self.nodes):
            x = i * (box_w + gap)
            c.setFillColor(PANEL)
            c.setStrokeColor(BORDER)
            c.roundRect(x, top - box_h, box_w, box_h, 8, fill=1, stroke=1)
            c.setFillColor(self.color)
            c.setFont("Helvetica-Bold", 8.4)
            c.drawString(x + 8, top - 16, head)
            c.setFillColor(MUTED)
            c.setFont("Helvetica", 7.2)
            for j, line in enumerate(self._wrapped(body, box_w - 16, "Helvetica", 7.2)[:3]):
                c.drawString(x + 8, top - 30 - 9 * j, line)
            if i < n - 1:
                x1 = x + box_w + 2
                x2 = x + box_w + gap - 3
                y = top - box_h / 2
                c.setStrokeColor(self.color)
                c.setLineWidth(1.25)
                c.line(x1, y, x2, y)
                c.setFillColor(self.color)
                c.line(x2, y, x2 - 4, y + 3)
                c.line(x2, y, x2 - 4, y - 3)


class LayerDiagram(Flowable):
    def __init__(self, width: float = CONTENT_W):
        super().__init__()
        self.width = width
        self._rows = [
            ("User Experience", "Expo app, onboarding, portfolio, charting, quick trade, IBAN accounts, cards roadmap", GOLD_LIGHT, GOLD),
            ("Wallet Layer", "Privy embedded EOA, ERC-4337 smart wallet, hidden Solana account, user-side signing", BLUE_LIGHT, BLUE),
            ("UR.APP", "External Wallet Access, URID, IBAN, fiat tokens, FX, cards", colors.HexColor("#FEF3C7"), colors.HexColor("#D97706")),
            ("Trading Layer", "Hyperliquid info/exchange APIs, API wallet setup, builder fee approval, WebSocket state", GREEN_LIGHT, GREEN),
            ("Relay Layer", "Arbitrum USDC, EIP-7702 + Ambire batches, EIP-2612 permits, relayer pools", colors.HexColor("#F3E8FF"), PURPLE),
            ("Coordination Layer", "Railway replicas, Supabase locks, idempotency, worker leadership, notifications", LIGHT, MUTED),
        ]
        # Height must cover every row's roundRect (bottom = y - 28) plus bottom padding.
        # Understating this caused the next flowable to overlap the Coordination row.
        row_step = 35
        box_offset = 28
        top_pad = 22
        bottom_pad = 16
        n = len(self._rows)
        self.height = (top_pad + (n - 1) * row_step + box_offset + bottom_pad) / 28.35 * cm

    def draw(self):
        c = self.canv
        rows = self._rows
        y = self.height - 22
        for title, body, fill, stroke in rows:
            c.setFillColor(fill)
            c.setStrokeColor(stroke)
            c.roundRect(0, y - 28, self.width, 30, 8, fill=1, stroke=1)
            c.setFillColor(NAVY)
            c.setFont("Helvetica-Bold", 9)
            c.drawString(12, y - 10, title)
            c.setFillColor(MUTED)
            c.setFont("Helvetica", 8)
            c.drawString(150, y - 10, body[:105])
            y -= 35


class TrustDiagram(Flowable):
    def __init__(self, width: float = CONTENT_W):
        super().__init__()
        self.width = width
        self.height = 5.9 * cm

    def draw(self):
        c = self.canv
        left_w = self.width * 0.47
        right_x = left_w + 36
        right_w = self.width - right_x
        c.setFillColor(GREEN_LIGHT)
        c.setStrokeColor(GREEN)
        c.roundRect(0, 48, left_w, 98, 10, fill=1, stroke=1)
        c.setFillColor(NAVY)
        c.setFont("Helvetica-Bold", 11)
        c.drawString(14, 125, "User-controlled")
        c.setFont("Helvetica", 8)
        for i, line in enumerate(["Privy wallet keys", "EIP-712 approvals", "7702 + Ambire batches", "USDC / fiat permits"]):
            c.drawString(16, 105 - i * 15, line)
        c.setFillColor(colors.HexColor("#FEF2F2"))
        c.setStrokeColor(RED)
        c.roundRect(right_x, 48, right_w, 98, 10, fill=1, stroke=1)
        c.setFillColor(NAVY)
        c.setFont("Helvetica-Bold", 11)
        c.drawString(right_x + 14, 125, "Backend-controlled")
        c.setFont("Helvetica", 8)
        for i, line in enumerate(["Relayer gas payment", "Nonce locks", "Market data orchestration", "Operational records"]):
            c.drawString(right_x + 16, 105 - i * 15, line)
        c.setStrokeColor(GOLD)
        c.setLineWidth(2)
        c.line(left_w + 18, 40, left_w + 18, 154)
        c.setFillColor(GOLD)
        c.setFont("Helvetica-Bold", 8)
        c.drawCentredString(left_w + 18, 24, "TRUST BOUNDARY")


def bg(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(colors.white)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    canvas.setFillColor(colors.HexColor("#FAFBFE"))
    canvas.rect(0, PAGE_H - 2.2 * cm, PAGE_W, 2.2 * cm, fill=1, stroke=0)
    canvas.setStrokeColor(BORDER)
    canvas.line(MARGIN_X, 1.35 * cm, PAGE_W - MARGIN_X, 1.35 * cm)
    if doc.page > 1:
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(MARGIN_X, 0.85 * cm, "Lunatic Wisdom Labs Whitepaper")
        canvas.drawRightString(PAGE_W - MARGIN_X, 0.85 * cm, str(doc.page))
    canvas.restoreState()


class WhitepaperDoc(SimpleDocTemplate):
    """Collects H1 (+ §6.1) for a compact TOC — subsection detail stays in-body only."""

    toc_entries: List[tuple] = []

    def afterFlowable(self, flowable):
        if not isinstance(flowable, Paragraph):
            return
        style_name = flowable.style.name
        text = flowable.getPlainText().strip()
        if not text:
            return
        if style_name == "H1":
            WhitepaperDoc.toc_entries.append((0, text, self.page))
        elif style_name == "H2" and text.startswith("6.1"):
            WhitepaperDoc.toc_entries.append((1, text, self.page))


def manual_toc_paragraphs(entries: Sequence[tuple]) -> List:
    flows: List = []
    for level, text, page in entries:
        flows.append(
            P(
                f"{text} "
                f"<font name='Helvetica' color='#707080' size='9'>{page}</font>",
                "TOCSub" if level else "TOC",
            )
        )
    return flows


def story(toc_entries: Sequence[tuple] | None = None) -> List:
    s: List = []

    # Cover
    s.append(Spacer(1, 2.4 * cm))
    s.append(P("LUNATIC WISDOM LABS WHITEPAPER", "Eyebrow"))
    s.append(P("Building the Future of AI &amp; Self-Custody", "CoverTitle"))
    s.append(P("No intermediaries. No compromises.", "Quote"))
    s.append(P("We create open-source, AI-powered onchain solutions that empower users with true ownership of their digital assets.", "CoverSub"))
    s.append(FeatureStrip([
        ("Studio", "Lunatic Wisdom Labs"),
        ("Live", "HyperTrade · OrbCast"),
        ("Custody", "User-held keys"),
        ("Token", "LWL only"),
        ("Source", "Open"),
    ]))
    s.append(Spacer(1, 0.5 * cm))
    s.append(Callout("Labs thesis: ship multiple products that keep users in control of keys and signatures, publish the work as open source, and use one token — LWL — wherever product revenue supports the token."))
    s.append(Spacer(1, 0.35 * cm))
    s.append(P(
        f"Draft generated {date.today().isoformat()} • Lunatic Wisdom Labs LLC · Wyoming, USA · {LWL_SITE}",
        "Small",
    ))
    s.append(PageBreak())

    # Contents — dedicated page only; body always starts on the next page
    s.append(P("Contents", "ContentsHead"))
    if toc_entries is not None:
        s.append(Spacer(1, 0.2 * cm))
        s.extend(manual_toc_paragraphs(toc_entries))
    s.append(PageBreak())

    # §1–3 flow together on early pages (no forced breaks between them)
    s.extend(chapter("1. Vision and Goals", style="body"))
    s.append(P(f"<b>Lunatic Wisdom Labs LLC</b> ({LWL_SITE}) is a Wyoming studio that publishes open-source, onchain products. Users hold their own keys. The labs does not take custody of wallet funds in order to operate an interface. AI is part of the studio brief — used where a product actually needs it — not a slogan pasted onto every app."))
    s.append(P("The audience is global: people who want dollar-denominated balances and clear market access on a phone, and people who already know how signing, gas, and order books work. LWL ships more than one product so those needs do not have to live in a single binary or a single market type."))
    s.append(bullets([
        "<b>Self-custody:</b> embedded wallets, user-signed actions, no company balance sheet of user deposits.",
        "<b>Open source:</b> each live product is published so it can be inspected, forked, and improved.",
        "<b>AI where it fits:</b> HyperTrade includes market intelligence and optional trading agents. OrbCast v1 does not run an AI worker.",
        "<b>One token:</b> LWL is the only LWL token. Products do not get their own tickers (see §11).",
    ]))
    s.append(Callout("The studio goal is not to put every market in one app. It is to keep shipping interfaces that stay non-custodial, remain open source, and feed a single token policy when they earn revenue.", tone="blue"))

    s.extend(chapter("2. Products"))
    s.append(P("Two products are live. A further project is listed as in development on the labs site and is not specified in this draft. Products share a custody posture and the LWL token; they do not share one app, one order path, or one compliance stack."))
    s.append(make_table([
        ["Product", "What it is", "Where to look"],
        [
            "HyperTrade",
            "Self-custodial mobile interface for onchain trading and optional stablecoin finance: perpetuals (including non-crypto HIP-3 books), optional UR.APP IBAN/card rails, and optional AI trading agents.",
            f"{HT_SITE} · {HT_GITHUB}",
        ],
        [
            "OrbCast",
            "Self-custodial interface for HIP-4 outcome / prediction markets (sports and event books). Showcase is sports. No perpetual futures, HIP-3 books, banking, or AI worker in v1.",
            f"{OC_SITE} · {OC_GITHUB}",
        ],
        [
            "Further work",
            "The labs site lists a next project as in development. This paper does not describe it.",
            LWL_SITE,
        ],
    ], [3.2 * cm, 8.4 * cm, 5.0 * cm]))
    s.append(Spacer(1, 0.2 * cm))
    s.append(P("Technical chapters from §4 onward describe <b>HyperTrade</b> in depth (architecture, wallet, UR.APP, agents). OrbCast is in scope as a sibling product and as a revenue source for LWL — not as a second architecture dump."))
    s.append(Callout("Shared rails today include Privy embedded wallets, user-signed gasless USDC where a product uses them, and transparent interface fees. What a given product lists, signs, or verifies is product-specific.", tone="blue"))

    s.extend(chapter("3. Why Now: Global Stablecoins and Onchain Markets"))
    s.append(P("Stablecoins have become one of crypto's clearest product-market-fit categories: dollar-like balances, global transferability, and fast settlement. At the same time, onchain market infrastructure is moving beyond crypto-only speculation into equities, commodities, FX, index exposure, and event / outcome books."))
    s.append(P("LWL sits at that convergence with more than one product. A user who wants always-on macro and perps uses HyperTrade. A user who wants event and sports outcomes uses OrbCast. A HyperTrade user who starts with a USDC trading balance can later use portfolio tools, AI analysis, or — if they opt in — card and IBAN rails. Those paths are not copied onto OrbCast."))
    s.append(P("This matters globally. In many markets, access to stable dollar balances, always-on markets, and event markets is more useful than another zero-utility token. The labs thesis is that useful financial interfaces will outperform purely narrative-driven crypto applications."))
    s.append(FeatureStrip([
        ("Stablecoins", "payments + savings"),
        ("Perps", "HyperTrade"),
        ("Outcomes", "OrbCast"),
        ("AI", "where the product uses it"),
    ]))

    # 3 — own page so the heading sits at the top (not orphaned from its body on the prior page)
    s.extend(chapter("4. HyperTrade: A Trading Interface for Every Level", style="page"))
    s.append(P("HyperTrade is an interface, not a traditional broker. The app helps users prepare, sign, and submit transactions while keeping funds in user-controlled wallets and routing execution to external onchain infrastructure."))
    s.append(make_table([
        ["User Need", "HyperTrade Response"],
        ["Easy onboarding", "Privy email, Google, and Apple login with automatic embedded wallet creation."],
        ["Simple balances", "Wallet balance, trading balance, and portfolio screens with clear transfer states."],
        ["Fast trading", "Hyperliquid API-wallet setup enables one-tap order signing after user approval."],
        ["Risk awareness", "Margin previews, leverage controls, liquidation estimates, reduce-only guards, and education-first copy."],
        ["Future everyday finance", f"IBAN accounts, FX, and debit cards via {UR_APP} (External Wallet Access mode)."],
    ], [5.0 * cm, 11.4 * cm]))
    s.append(Spacer(1, 0.28 * cm))
    s.append(H2("Experience principles"))
    s.append(bullets([
        "<b>Start simple, reveal depth:</b> new users can place a straightforward trade, while advanced users still get leverage, margin mode, order editing, and portfolio controls.",
        "<b>Make balances legible:</b> wallet funds, trading funds, and future card balances should never be ambiguous.",
        "<b>Respect user control:</b> every sensitive action remains user-authorized, even when the app hides operational complexity.",
    ]))

    # 4 — diagram-heavy; fresh page
    s.extend(chapter("5. HyperTrade Architecture Overview", style="page"))
    s.append(P(f"HyperTrade's architecture is intentionally modular. User identity and wallet signing live in the mobile app. Backend services coordinate relays, market data, notifications, and operational state. Hyperliquid is the active execution venue for this product. Arbitrum USDC is the stablecoin settlement rail. IBAN-backed fiat accounts and card rails are delivered through <b>{UR_APP}</b> ({UR_DOCS_HOME}) via External Wallet Access — user-signed flows with regulated fiat-token rules on Mantle (see §6.1). HyperTrade remains a non-custodial interface for wallet keys and trading; it does not hold user funds."))
    s.append(LayerDiagram())
    s.append(Spacer(1, 0.65 * cm))
    s.append(FlowDiagram("System flow: from user intent to execution", [
        ("Mobile app", "User chooses market, size, leverage, and transfer intent."),
        ("Privy wallet", "User signs permits or EIP-712 authorizations on device."),
        ("Backend relay", "Validates auth, assigns relayer, coordinates locks and retries."),
        ("Arbitrum + HL", "USDC settles on Arbitrum; trading executes on Hyperliquid."),
    ], color=BLUE))

    # 6 — diagram-heavy; fresh page; §6.1 continues below without another break
    s.extend(chapter("6. Wallet, Custody, and Gasless Infrastructure", style="page"))
    s.append(P("HyperTrade uses Privy to make wallet ownership accessible. Users can authenticate through email, Google, or Apple. The app creates an embedded Ethereum wallet for users without one, wires a Privy smart wallet for ERC-4337 account abstraction, and defensively creates a Solana wallet that remains hidden from the UI today. Arbitrum is the active EVM chain."))
    s.append(TrustDiagram())
    s.append(H2("Gasless relayer design"))
    s.append(P("Users sign EIP-2612 USDC permits on device. The backend cannot move funds by itself; it can only submit the exact action authorized by the user. A deterministic relayer assignment maps each wallet to one relayer, and Supabase locks serialize nonce-sensitive execution across Railway replicas."))
    s.append(FlowDiagram("Gasless USDC permit relay", [
        ("Permit", "User signs EIP-2612 approval for a scoped spender and amount."),
        ("Assign", "Backend hashes the user address to select a relayer."),
        ("Lock", "Supabase prevents concurrent nonce collisions for that relayer."),
        ("Execute", "Relayer pays gas and submits permit + transferFrom."),
    ], color=GOLD))

    # 5.1 — UR.APP integration (subsection of §5)
    s.append(Spacer(1, 0.35 * cm))
    s.append(H2(f"6.1 {UR_APP} Integration: External Wallet Access and IBAN Accounts"))
    s.append(P(
        f"<b>{UR_APP}</b> is the regulated banking infrastructure that powers HyperTrade's IBAN accounts, fiat-token balances, FX, pay-in/payout, and debit card rails. HyperTrade is a partner interface on top of {UR_APP}'s APIs and onchain contracts — not a custodian. Developer documentation lives at {UR_DOCS_HOME}; contract source and audit reports are in {ext_link('https://github.com/ur-app/ur-contracts', 'ur-app/ur-contracts')} (UR no longer publishes a public smart-contracts docs page)."
    ))
    s.append(H2(f"How HyperTrade integrates with {UR_APP}"))
    s.append(P(f"{UR_APP} integrations are built from three independent choices: <b>Account Mode</b> (who holds fiat and who signs), <b>Card Mode</b> (what funds card spend), and <b>KYC Mode</b> (how identity is verified). HyperTrade enables {UR_APP} by default; the same product can also run as trading-only — Privy, Arbitrum USDC, and Hyperliquid — without {UR_APP} credentials, Mantle banking contracts, or KYC (see §6.1 custody boundary)."))
    s.append(make_table([
        [f"{UR_APP} integration choice", f"What {UR_APP} offers", "What HyperTrade uses"],
        ["Account Mode", "Managed Custody (partner signs fiat) · External Wallet Access (user wallet signs)", "External Wallet Access — user signs; UR rules apply to fiat tokens"],
        ["Card Mode", "Fiat Only (spend fiat balance) · Crypto Backed (real-time auth against crypto)", "Fiat Only — fiat-backed card (roadmap)"],
        ["KYC Mode", f"{UR_APP} webview · Sumsub SDK · Sumsub reuse", "Sumsub SDK in the HyperTrade mobile app"],
    ], [3.4 * cm, 5.8 * cm, 5.2 * cm]))
    s.append(Spacer(1, 0.15 * cm))
    s.append(P(f"<b>External Wallet Access (HyperTrade's Account Mode):</b> the user's Privy embedded EOA owns the onchain <b>URID</b> (ERC-721 identity NFT) and receives <b>fiat-token balances</b> (e.g. USD24, EUR24) at the user's wallet address on Mantle. Banking actions require the user to sign — via EIP-712, EIP-2612 permits, or EIP-7702 batched execution — while HyperTrade sponsors gas where possible. This is not the same as holding raw USDC: once USDC is deposited into {UR_APP} contracts, credited balances are {UR_APP}-regulated fiat tokens subject to {UR_APP}'s terms and compliance controls (see custody boundary below)."))
    s.append(P(f"<b>Managed Custody (not used by HyperTrade):</b> in {UR_APP}'s alternative Account Mode, fiat lives in a {UR_APP}-managed account and the partner backend signs fiat actions on the user's behalf. This suits consumer neobanks that hide wallet mechanics. HyperTrade deliberately chose External Wallet Access so users sign each banking action and URID ownership stays visible onchain at the user's EOA."))
    s.append(P(f"<b>Fiat Only cards (HyperTrade's Card Mode):</b> when card spend is enabled, the debit card draws from the user's {UR_APP} fiat balance (tokenized deposits). Users who want to spend crypto first off-ramp into fiat, then tap the card. <b>Crypto Backed</b> — {UR_APP}'s alternative Card Mode where swipes settle against crypto via a partner prefund pool and real-time authorization webhooks — is not part of HyperTrade's design."))
    s.append(Callout(f"Design principle: {UR_APP} supplies regulated IBAN rails and onchain fiat tokens; HyperTrade supplies UX, Privy wallet connectivity, and gasless relay infrastructure — without becoming a custodian of wallet keys or trading balances.", tone="blue"))
    s.append(H2("Custody boundary: wallet USDC vs UR fiat tokens"))
    s.append(P("HyperTrade's non-custodial posture applies to the core trading stack: Privy wallet keys stay on the user's device, Arbitrum USDC in the wallet before any deposit is user-controlled, and Hyperliquid trading balances move only under user-authorized API-wallet signatures. HyperTrade does not take custody of those assets."))
    s.append(P(f"When a user <b>opts in</b> to {UR_APP} banking and runs Add Money, USDC on Arbitrum is approved and deposited into {UR_APP}'s onchain contracts (e.g. Fiat24CryptoDeposit). Settlement credits regulated fiat tokens such as <b>USD24</b> or <b>EUR24</b> on Mantle. In External Wallet Access mode those tokens appear at the user's EOA address, but they are <b>{UR_APP}-issued fiat tokens</b> moving through {UR_APP}'s contract system — not generic self-custodied USDC. IBAN pay-in, FX, payout, and card spend are governed by {UR_APP}'s smart-contract permissions, API policies, and licensed compliance program."))
    s.append(P(f"That regulated layer is expected to carry restrictions that do not apply to raw wallet USDC: KYC-gated account status, sanctions screening, AML monitoring, and — where law or {UR_APP}'s compliance program requires — <b>freezes, holds, or blocks</b> on token movement. Users can typically off-ramp back to USDC in their own wallet via signed withdraw flows, but while balances remain in USD24/EUR24 form, <b>{UR_APP}'s terms of service and regulatory obligations apply</b>; HyperTrade cannot override them."))
    s.append(Callout(f"{UR_APP} IBAN, fiat-token, and card rails are <b>optional</b>. HyperTrade can ship as Privy + Arbitrum USDC + Hyperliquid trading only — without {UR_APP} API credentials, Mantle banking contracts, or KYC flows.", tone="blue"))
    s.append(H2("Onchain identity and IBAN account model"))
    s.append(bullets([
        "<b>URID (Fiat24Account):</b> each user receives an ERC-721 identity NFT minted to their Privy EOA on Mantle, gating access to IBAN accounts and card products. KYC status is recorded onchain in the contract's <i>status</i> mapping (e.g. Tourist → Live).",
        f"<b>Fiat tokens at the EOA:</b> USD24, EUR24, CHF24, and related balances are credited to the user's Mantle address in External Wallet Access mode, but they are {UR_APP}-regulated ERC-20 fiat tokens — subject to {UR_APP} contract rules, URID status, and compliance controls (including freezes or holds where required).",
        "<b>IBAN provisioning:</b> after KYC reaches <i>Live</i>, UR.APP provisions SEPA/SWIFT IBAN details via the Profile API; inbound wires credit the user's fiat-token balance once settlement completes.",
    ]))
    s.append(H2("KYC and identity verification (Sumsub)"))
    s.append(P(f"Identity verification for IBAN accounts is delivered through <b>Sumsub</b>, integrated via {UR_APP}'s compliance stack using the <b>Sumsub SDK in your app</b> KYC mode. Users complete document capture, liveness checks, and identity verification inside the Sumsub mobile SDK surfaced from HyperTrade."))
    s.append(P(f"HyperTrade does <b>not</b> store user identity documents, biometric captures, or other sensitive KYC payloads on its own servers. The app embeds the Sumsub SDK for the capture UX and exchanges short-lived access tokens through {UR_APP} API endpoints (e.g. account-status and create-access-token flows). HyperTrade backends receive only the <i>outcome</i> needed to gate product features — verification status, chain eligibility, and compliance state — not copies of passports, selfies, or raw document files."))
    s.append(bullets([
        f"<b>SDK on device:</b> document and liveness capture runs in Sumsub's SDK; sensitive media stays in Sumsub / {UR_APP} supervised infrastructure.",
        f"<b>API orchestration only:</b> HyperTrade calls {UR_APP} endpoints to mint SDK tokens and poll verification status.",
        "<b>No doc vault:</b> HyperTrade operational databases hold wallet links, job state, and feature flags — not KYC document archives.",
        f"<b>{UR_APP}-led retention:</b> document retention, AML obligations, and regulatory record-keeping are governed by {UR_APP} and Sumsub under their licenses.",
    ]))
    s.append(H2("Gasless flows: EIP-7702, Ambire, and permit relays"))
    s.append(P(f"Several {UR_APP} banking actions require onchain authorization. HyperTrade sponsors gas so users never need native tokens for Mantle or Arbitrum operations. Two relay patterns cover the majority of flows:"))
    s.append(make_table([
        ["Flow", "Chain", "Authorization pattern", "What the user signs"],
        ["Add Money (USDC → fiat)", "Arbitrum → Mantle (LZ)", "EIP-7702 + Ambire batched execute", "7702 SetCode authorization (once per chain) + Ambire batch signature for approve + deposit"],
        ["FX Convert (fiat ↔ fiat)", "Mantle", "EIP-7702 + Ambire batched execute", "Same 7702 delegation + batch signature for approve + moneyExchangeExactIn"],
        ["Withdraw / Payout", "Mantle", "EIP-2612 permit (REST settlement)", f"EIP-2612 permit authorizing {UR_APP} to debit fiat tokens"],
        ["Hyperliquid deposit", "Arbitrum", "EIP-2612 USDC permit", "Scoped USDC permit for relayer transferFrom"],
    ], [3.2 * cm, 2.4 * cm, 4.6 * cm, 5.2 * cm]))
    s.append(Spacer(1, 0.2 * cm))
    s.append(P("<b>EIP-7702 delegation:</b> on first use per chain, the user signs an EIP-7702 authorization that temporarily delegates their EOA to Ambire's audited AmbireAccount7702 implementation. The EOA's code slot becomes <i>0xef0100 + delegate address</i>, enabling batched execution with <i>_msgSender() == user EOA</i> so UR contracts (e.g. Fiat24CryptoDeposit) resolve the correct URID owner."))
    s.append(P(f"<b>Ambire batch execution:</b> the user signs an off-chain Ambire batch hash (raw secp256k1, no EIP-191 prefix). HyperTrade's dedicated {UR_APP} relayer pool broadcasts a type-4 (EIP-7702) transaction that attaches the authorization, invokes <i>EOA.execute(calls[], signature)</i>, and pays gas plus any LayerZero cross-chain fees. Relayer assignment is deterministic per wallet with Supabase locks to prevent nonce collisions across Railway replicas."))
    s.append(FlowDiagram("Add Money: EIP-7702 gasless deposit", [
        ("Quote", f"User enters USDC amount; backend fetches {UR_APP} quote + contract addresses."),
        ("Delegate", "User signs 7702 SetCode auth binding EOA to Ambire delegate (once per chain)."),
        ("Batch sign", "User signs approve + depositTokenViaUsdc calls via Ambire batch hash."),
        ("Relay", "HyperTrade relayer broadcasts type-4 tx; LZ bridges USDC; UR contracts credit USD24/EUR24 on Mantle."),
    ], color=colors.HexColor("#D97706")))
    s.append(H2("Operational verbs enabled today and on roadmap"))
    s.append(bullets([
        "<b>Pay-in:</b> user wires fiat to their IBAN; balance credits on settlement.",
        "<b>Payout:</b> user signs and sends fiat from IBAN balance to an external beneficiary via SEPA/SWIFT.",
        "<b>On-ramp / Add Money:</b> USDC on Arbitrum deposits into UR.APP contracts; Mantle balance credits as USD24/EUR24 (regulated fiat tokens, not raw USDC).",
        "<b>Off-ramp / Withdraw:</b> fiat tokens convert back to USDC in the user's wallet via permit-authorized settlement.",
        "<b>FX:</b> gasless fiat-to-fiat conversion on Mantle via 7702 + Ambire.",
        f"<b>Debit card (roadmap):</b> Fiat Only mode — card spend draws from {UR_APP} fiat balance; card credentials revealed in {UR_APP} secure webview.",
    ]))
    s.append(P(f"Withdraw and payout flows use {UR_APP}'s permit REST API: the user signs an EIP-2612 permit on device, and {UR_APP} submits and pays for onchain settlement — HyperTrade's relayer does not move funds the user did not authorize.", "Body"))

    # 7+
    s.extend(chapter("7. Markets and Execution", style="smart"))
    s.append(P("HyperTrade's live trading path uses Hyperliquid: info APIs, exchange APIs, WebSocket state, API-wallet order signing, builder fee approvals, and environment-scoped caches for live vs test."))
    s.append(P("Onchain perpetual markets are expanding beyond crypto. Public reporting in early 2026 cited Hyperliquid HIP-3 markets reaching roughly $1.4B in open interest, with oil and other non-crypto markets driving significant demand. HyperTrade can list HIP-3 providers such as XYZ Markets and other deployers as they bring more of those books onchain — oil, gold, forex, large equities, and major indices — rather than only crypto-native tickers."))
    s.append(P(f"Outcome / prediction markets are a separate LWL product. <b>OrbCast</b> ({OC_SITE}, {OC_GITHUB}) is the HIP-4 interface: binary and multi-outcome books, sports as the showcase, self-custody, and no perps, HIP-3, banking, or AI worker in v1. HIP-4 is not a HyperTrade roadmap item and is not folded into the HyperTrade tab."))
    s.append(P("Perpetuals, non-crypto HIP-3 books, and outcome books all point at the same user demand: trading views about the world, not only crypto token prices. LWL meets that demand with more than one product."))
    s.append(FlowDiagram("HyperTrade trading setup", [
        ("Fund", "User moves USDC into trading balance."),
        ("Approve", "User approves API wallet and builder fee cap."),
        ("Sign", "API wallet signs fast order flow."),
        ("Execute", "The venue validates margin, fees, and market rules."),
    ], color=GREEN))

    # 8–13 — revenue through risk; tokenomics at §11; regulatory sits just before appendix
    s.extend(chapter("8. Revenue Model and Sustainable Growth", style="smart"))
    s.append(P(f"LWL products are designed as interface layers. They do not need to operate a matching engine, custodian, market maker balance sheet, or exchange back office to begin monetizing. HyperTrade sits on Privy, Arbitrum USDC, optional {UR_APP} IBAN rails, Supabase, Railway, and Hyperliquid execution. OrbCast uses the same class of wallet and interface-fee model on HIP-4 books."))
    s.append(P("Where a product takes a transparent builder or interface fee, users approve a fee cap and orders can include that product's builder code. Revenue is usage-based. <b>Any</b> realized LWL product revenue — HyperTrade, OrbCast, and future revenue-generating projects — can fund LWL buybacks and burns. The share applied is dynamic and never below 70% (see §11). Alignment is simple: revenue grows with real product use, not with custody or hidden spreads."))
    s.append(make_table([
        ["Revenue Stream", "Product", "Why It Scales"],
        ["Builder / interface fees", "HyperTrade (active)", "Usage-based order flow through the interface, with user-approved fee caps."],
        ["Builder / interface fees", "OrbCast", "Same fee class on HIP-4 outcome flow as that product earns it."],
        ["Cards and payments", "HyperTrade (roadmap)", f"Possible partner revenue from card activity, IBAN top-ups, FX/spend, or negotiated share with {UR_APP}."],
        ["AI-assisted agents", "HyperTrade (active)", "House LLM + market-data pipeline; monetization aligned with fees on agent-originated flow."],
        ["Future products", "LWL", "Any later revenue-generating LWL project uses the same single-token buyback and burn policy."],
    ], [4.2 * cm, 4.2 * cm, 8.0 * cm]))
    s.append(H2("Cost structure"))
    s.append(bullets([
        "<b>Low fixed cost:</b> Railway, Supabase, Privy, RPC providers, notifications, analytics, and standard monitoring are manageable compared with operating exchange or custody infrastructure.",
        "<b>Usage-aligned upside:</b> builder revenue increases as real trading usage increases.",
        "<b>Operational leverage:</b> more users do not require a proportional increase in headcount or servers because core coordination is stateless and lock-driven.",
        "<b>Runway discipline:</b> modest infrastructure costs reduce pressure to over-monetize early users before the product and regulatory environment are ready.",
    ]))
    s.append(Callout("Business model principle: monetize the interface layer transparently while keeping custody, settlement, and market execution in specialized infrastructure.", tone="blue"))

    # 8
    s.extend(chapter("9. AI Agents and Market Intelligence", style="smart"))
    s.append(P("AI is a HyperTrade surface, not an OrbCast v1 feature. HyperTrade combines <b>in-app market analysis</b> (Gemini-backed research for human traders) and <b>AI Trading Agents</b> — autonomous agents that monitor Hyperliquid perps, reason over structured market context, and place orders through HL named-agent keys the user explicitly approves."))
    s.append(P("The agent stack is split into a <b>control plane</b> and an <b>execution plane</b>. The mobile app and FastAPI backend handle agent CRUD, Privy JWT auth, wallet-ownership checks, and the approve-agent ceremony. A dedicated <b>ai-agent-worker</b> service (Node/TypeScript on Railway) runs the trading brain and HL order flow — it holds no public HTTP surface and talks to Supabase with the service role only."))
    s.append(FlowDiagram("AI agent runtime (hourly cycle)", [
        ("Ingest", "Per-symbol market cache: futures OHLC, OI, funding, flows, ETF demand, macro calendar, HL mids."),
        ("Reason", "Opening + winning/losing monitor prompts → structured JSON via user-chosen LLM."),
        ("Guard", "Schema validation, budget/leverage caps, symbol-conflict checks."),
        ("Execute", "HL agent key signs orders/TP-SL; builder fee attached; decisions logged to Supabase."),
    ], color=PURPLE))
    s.append(H2("Agent modes and custody boundary"))
    s.append(P("Agents run in two modes. <b>Shared</b> trades from the user's main unified Hyperliquid balance, bounded by per-agent <b>max_capital_usd</b>, optional per-position caps, leverage limits, and a symbol allowlist. <b>Dedicated</b> trades from a segregated HL sub-account (volume-gated), with the same named-agent signing model and a hard isolation boundary at the clearinghouse. Each agent receives its own HL keypair; the user approves it as a <b>named agent</b> (<i>approveAgent</i>) alongside the device's manual trading agent. HL protocol guarantees agent keys can sign L1 order actions only — not withdrawals — even if backend data were tampered with."))
    s.append(P("Agent private keys are generated in the worker, encrypted with <b>AES-256-GCM</b> under a Railway-only <i>AGENT_KMS_KEY</i>, and stored as ciphertext in Supabase. The backend never holds LLM API keys; model inference runs on the worker using house provider keys (Gemini, Grok, OpenAI, DeepSeek, Claude). Users can pause, stop, or revoke agents at any time."))
    s.append(H2("Brain: data → flags → prompts → validation"))
    s.append(P("Market context is assembled in two phases each cycle. <b>Phase 1</b> builds a shared per-symbol snapshot once per coin — aggregated futures and spot history, open interest, funding, taker flow, liquidations, premium/basis vs spot, plus symbol-specific overlays: Deribit DVOL options context for BTC/ETH, spot-ETF flow history for BTC/ETH/SOL/XRP, and a macro calendar slice (US holidays + high-impact CPI/FOMC windows). Slow-moving context is persisted in a <b>global_context_cache</b> table so all agents and worker restarts share one refresh, not N duplicate pulls."))
    s.append(P("<b>Phase 2</b> fans out per active agent. Raw series feed <b>computeScalperFlags</b> and a composite long/short score. The brain then branches:"))
    s.append(bullets([
        "<b>Opening path</b> — for flat symbols: opening prompt with session context, conviction bands, planned stop anchors, and macro/ETF sections. Responses are JSON-validated; sub-conviction setups are skipped until market context updates.",
        "<b>Winning monitor</b> — for profitable positions: hold / add / trim / exit with stop-management rules (breakeven, tighter) that never loosen protective stops.",
        "<b>Losing monitor</b> — for underwater positions: hold / cut / exit with stored opening thesis and invalidation criteria replayed into the prompt.",
    ]))
    s.append(P("LLM output is treated as <b>untrusted input</b>. Validators clamp leverage, size, symbol allowlists, and reduce-only integrity before the HL adapter sees an order. Live mids from Hyperliquid (cycle-cached) anchor decisions; cached OHLC snapshots are fallback when mids are unavailable. Opening decisions for the same symbol + model dedupe within a cycle so parallel agents do not burn duplicate LLM calls."))
    s.append(H2("Execution adapter and conflict guards"))
    s.append(P("The HL execution adapter is a server-side port of HyperTrade's signing semantics: unified-account free margin, position-linked TP/SL via <i>positionTpsl</i>, reduce-only IOC exits with in-cycle retries, and HyperTrade's builder fee on every agent order. Budget headroom for new opens uses live mark notional so inflated winners consume cap honestly."))
    s.append(make_table([
        ["Guard", "Behavior"],
        ["User conflict", "Skip opening a coin where the user already holds a manual position the agent does not own."],
        ["Peer conflict", "Shared agents on the same master wallet run sequentially and claim symbols so two agents cannot race the same coin. Dedicated agents are isolated on their own sub-account."],
        ["Manual close", "If the user closes or reduces an agent position externally, the worker adopts reality and does not re-open."],
        ["Order tagging", "Agent orders carry a deterministic <i>cloid</i> prefix so portfolio UI can badge bot-managed coins."],
    ], [4.2 * cm, 11.2 * cm]))
    s.append(P("Every cycle writes an audit trail: <b>ai_agent_decisions</b> (structured decision + reasoning JSON), <b>ai_agent_positions</b> (thesis, stops, PnL state), and <b>ai_agent_runs</b> (equity snapshot for dashboard charts). Supabase RLS is deny-all on agent tables — only the backend and worker service role can read or mutate rows, scoped by <i>privy_user_id</i> at the API layer."))
    s.append(Callout("Product principle: AI agents automate research and execution within explicit user-approved bounds — named HL agent keys, not custodial trading accounts.", tone="blue"))

    # 9
    s.extend(chapter("10. Community Rewards and Roadmap", style="smart"))
    s.append(P("HyperTrade rewards active users through a loyalty tier system. Higher tiers unlock trading fee discounts tied to real usage — trading activity, referrals, and product engagement — so incentives stay aligned with authentic participation rather than passive farming. OrbCast has its own rewards surface; the two programs are not the same ledger."))
    s.append(H2("Roadmap themes"))
    s.append(bullets([
        "<b>LWL:</b> keep publishing open-source products, keep a single token, and apply the buyback and burn policy in §11 to any product revenue.",
        "<b>HyperTrade:</b> improve the core trading interface for casual and advanced users.",
        f"<b>HyperTrade:</b> expand optional stablecoin utility through {UR_APP} IBAN accounts, Fiat Only card partnerships, and everyday finance use cases.",
        "<b>HyperTrade:</b> operate AI Trading Agents (Shared and Dedicated) with worker-side brain, global market cache, and named-agent signing.",
        "<b>OrbCast:</b> grow the HIP-4 outcome catalog and sports/event UX. No perps, banking, or AI worker in v1.",
        "Maintain non-custodial architecture as each product expands.",
        "Deepen loyalty-tier fee discounts as usage and product surface area grow.",
    ]))

    # 10
    s.extend(chapter("11. LWL Tokenomics", style="smart"))
    s.append(P(f"<b>LWL</b> is the token of <b>Lunatic Wisdom Labs LLC</b>. It is the <b>only</b> LWL token. HyperTrade, OrbCast, and any later LWL product do not get their own tickers. LWL launched via a <b>fair launch</b> on Uniswap through <b>pools.trade</b> on Robinhood Chain."))
    s.append(P("Max supply is <b>1,000,000,000 LWL</b> (1 billion). No additional mint is described in this document."))
    s.append(make_table([
        ["Allocation", "Share", "Tokens", "Terms"],
        ["Public", "55%", "550,000,000", "Fair-launch float on Uniswap via pools.trade (Robinhood Chain)."],
        ["Ecosystem", "20%", "200,000,000", "Locked until November 2026."],
        ["AI agents", "10%", "100,000,000", "Locked until January 2027. Not for sale — see note below."],
        ["Team", "15%", "150,000,000", "Locked until August 2027."],
    ], [3.4 * cm, 2.2 * cm, 3.6 * cm, 7.2 * cm]))
    s.append(Callout("AI agents allocation: the 10% LWL reserved for AI agents is <b>not for sale</b> and can be treated as outside active circulation. A time lock is not the same as a burn — those tokens remain in existence until a future burn mechanism, if introduced, removes them.", tone="blue"))
    s.append(H2("Buybacks and burns"))
    s.append(P("Product activity supports LWL through on-market <b>buybacks and burns</b>, not by selling reserved allocations. The policy applies to <b>any</b> realized LWL revenue: HyperTrade, OrbCast, and future revenue-generating projects."))
    s.append(bullets([
        "<b>Single token:</b> only LWL. The labs will not issue a separate token per product.",
        "<b>Source:</b> realized product revenue (interface / builder fees and any later LWL revenue lines), plus 100% of pools.trade creator fees from the LWL fair-launch pool.",
        "<b>Share:</b> the portion of realized revenue used for buybacks and/or burns is <b>dynamic</b> and depends on market conditions. It is <b>never less than 70%</b>.",
        "<b>Form:</b> the split between buyback and burn inside that share can move with conditions; both are in scope.",
    ]))
    s.append(H2("Reserved AI-agents allocation"))
    s.append(P("A future mechanism may still retire the locked 10% AI-agents allocation through a burn rather than a sale. That path is not live in this draft. If introduced, it would be additive to the revenue-funded buyback and burn policy above — not a second token."))
    s.append(H2("On-chain references"))
    s.append(P("Locks and the token itself are on Robinhood Chain. Readers can verify supply and lock state on the explorer rather than taking the table on trust:"))
    s.append(bullets([
        f"<b>LWL token:</b> {ext_link('https://robinhoodchain.blockscout.com/token/0x7bb3E171EC502F65C08D38a61D51B9841524A72D', '0x7bb3E171EC502F65C08D38a61D51B9841524A72D')}",
        f"<b>Lock contract:</b> {ext_link('https://robinhoodchain.blockscout.com/address/0x20f0137CD23411bc165BE14eA0a4F8D59E59C505', '0x20f0137CD23411bc165BE14eA0a4F8D59E59C505')}",
    ]))
    s.append(P("LWL is not required to use HyperTrade, OrbCast, hold a wallet, or trade. This section describes token supply, locks, and revenue-linked buybacks and burns only. It is not an offer, solicitation, or investment advice.", "Small"))

    # 11
    s.extend(chapter("12. Risk, Security, and Trust Model", style="smart"))
    s.append(P("Each LWL product is a user interface, not a custodian. The table below is HyperTrade-weighted because that is where banking, 7702 relays, and AI agents live. OrbCast inherits the wallet, relayer, and interface-fee rows that apply to it; it does not inherit UR.APP, Sumsub, 7702 banking, or AI-agent key rows."))
    s.append(P("HyperTrade's security model is narrow by design. User wallets sign. Relayers relay. The trading venue executes. Supabase coordinates operational state. This separation reduces the blast radius of any one component and keeps wallet-key custody with users for the trading stack; optional UR.APP fiat-token flows add a regulated compliance layer governed by UR.APP (§6.1)."))
    s.append(make_table([
        ["Risk", "Current Control"],
        ["User key custody", "Privy device-side embedded wallet model; backend never stores user private keys."],
        ["Gasless relay abuse", "User-signed permits, deterministic relayer assignment, replay checks, rate limits."],
        ["Replica nonce collision", "Supabase relayer locks with TTL recovery."],
        ["Setup incompleteness", "Setup considered complete only when agent is active and builder fee is approved."],
        ["Third-party dependency", f"Clear dependency on Privy, Arbitrum, Mantle, Hyperliquid, {UR_APP}, oracles, and card partners."],
        ["7702 relay abuse", "User-signed 7702 authorizations and Ambire batches; relayer bound to URID owner; rate limits and inflight deposit guards."],
        ["Regulatory uncertainty", f"Non-custodial interface posture; {UR_APP}-led KYC/AML for regulated IBAN and card rails."],
        ["UR fiat-token compliance", f"USD24/EUR24 balances use {UR_APP} contracts; lawful freezes, holds, and KYC-gated restrictions are expected on the regulated rail — not applicable to raw wallet USDC or Hyperliquid-only usage."],
        ["AI agent key custody", "Per-agent HL keys encrypted AES-256-GCM; user approves named agent; HL blocks withdrawals from agent keys."],
        ["LLM output abuse", "Structured JSON validators + adapter hard caps on size, leverage, symbols; untrusted model output never sent raw to HL."],
        ["KYC data handling", "Sumsub SDK on device; HyperTrade stores verification outcomes only — no identity documents or biometric archives on HyperTrade servers."],
    ], [4.6 * cm, 11.8 * cm]))

    # 12 — regulatory context immediately before appendix
    s.extend(chapter("13. Regulatory and Policy Landscape", style="smart"))
    s.append(P("LWL products should be understood as user interfaces and wallet-connected applications, not as custodians. Market type still differs by product: HyperTrade is a perpetuals and optional-banking interface; OrbCast is an outcome-markets interface. Those are different legal and store surfaces. This distinction is increasingly important as regulators clarify how self-custodial trading interfaces fit within existing frameworks."))
    s.append(P("In April 2026, SEC Division of Trading and Markets staff issued a statement on broker-dealer registration for certain user interfaces used to prepare crypto asset securities transactions. The statement is not a Commission rule and has no independent legal force, but it is directionally important: it describes conditions under which staff would not object to certain covered user interface providers operating without broker-dealer registration, including self-custodial wallet contexts, objective parameters, educational material, disclosures, and no custody of user funds."))
    s.append(P("LWL product design is consistent with several principles highlighted in that staff statement: users control wallets, the app prepares transaction parameters, fees and limitations should be disclosed, and the interface should avoid discretionary control over user funds or execution decisions. This is not legal advice, and product rollout must continue to be reviewed jurisdiction by jurisdiction."))
    s.append(P("Separately, the Hyperliquid Policy Center launched in February 2026 as an independent research and advocacy organization focused on decentralized market infrastructure, perpetual derivatives, and practical regulatory frameworks. Policy clarity around decentralized markets can reduce uncertainty for builders, partners, and users of interfaces in that ecosystem."))

    # Appendix — continue on same page when prior section leaves room
    s.extend(chapter("14. Appendix: Factual Anchors, Audits, and Sources", style="gap"))
    s.append(H2("Lunatic Wisdom Labs"))
    s.append(bullets([
        f"<b>Labs:</b> {LWL_SITE} — Lunatic Wisdom Labs LLC, Wyoming, USA.",
        f"<b>HyperTrade:</b> {HT_SITE} · {HT_GITHUB}",
        f"<b>OrbCast:</b> {OC_SITE} · {OC_GITHUB}",
    ]))
    s.append(H2("Regulatory and ecosystem references"))
    s.append(bullets([
        "SEC Division of Trading and Markets staff statement, April 13 2026: covered user interfaces, self-custodial wallet contexts, objective parameters, disclosures, and no custody of user funds. The statement is staff view only and not a Commission rule.",
        "Hyperliquid Policy Center launch announcement, February 18 2026: independent 501(c)(4) research and advocacy organization focused on decentralized finance, perpetual derivatives, and blockchain-based financial infrastructure.",
        "Hyperliquid Policy Center About page: describes Hyperliquid as a public, permissionless blockchain and decentralized exchange known for perpetuals, transparency, accessibility, performance, and non-custodial use.",
        "Public market reporting in 2026 cited HIP-3 open interest around the $1.4B range and highlighted oil / non-crypto perpetuals as major drivers of growth.",
    ]))
    s.append(H2(f"{UR_APP} developer documentation"))
    s.append(bullets([
        f"<b>Developer docs home:</b> {UR_DOCS_HOME}",
        f"<b>Integration guide:</b> Account Mode, Card Mode, and KYC Mode choices — {ext_link('https://docs.ur.app/getting-started/integration-guide', 'integration guide')}",
        f"<b>External Wallet Access:</b> HyperTrade's Account Mode — {ext_link('https://docs.ur.app/integration-methods/external-wallet-access-mode', 'External Wallet Access docs')}",
        f"<b>Managed Custody:</b> alternative Account Mode (not used by HyperTrade) — {ext_link('https://docs.ur.app/integration-methods/managed-custody-mode', 'Managed Custody docs')}",
        f"<b>Contract source & audits:</b> {ext_link('https://github.com/ur-app/ur-contracts', 'ur-app/ur-contracts')} · {ext_link('https://github.com/ur-app/ur-contracts/tree/main/Audits', 'audit reports')} (UR removed the public smart-contracts docs page)",
    ]))
    s.append(H2("Third-party security audits"))
    s.append(P(f"HyperTrade relies on audited infrastructure from wallet, execution, relay, and {UR_APP} partners. Independent audit reports for key dependencies:"))
    s.append(bullets([
        f"<b>Ambire EIP-7702 delegate (Hunter Security):</b> audit of AmbireAccount7702 used for gasless batched execution — {ext_link('https://github.com/AmbireTech/ambire-common/blob/v2/audits/Ambire-EIP-7702-Update-Hunter-Security-Audit-Report-0.1.pdf', 'view audit report')}",
        f"<b>{UR_APP} onchain contracts (Blocksec):</b> Fiat24 deposit, relay, on-ramp, card authorization, and Mantle contract suites — {ext_link('https://github.com/ur-app/ur-contracts/tree/main/Audits', 'view audits on GitHub')}",
        f"<b>LayerZero (Endpoint V2, OFT, index):</b> cross-chain messaging and omnichain token bridges for Add Money (Arbitrum → Mantle) — {ext_link('https://github.com/LayerZero-Labs/Audits/tree/main/audits/Endpoint%20V2%20-%20EVM', 'Endpoint V2')}, {ext_link('https://github.com/LayerZero-Labs/Audits/tree/main/audits/OFT', 'OFT')}, {ext_link('https://github.com/LayerZero-Labs/Audits/tree/main/audits', 'full index')}",
        f"<b>Arbitrum native USDC (Trail of Bits):</b> audit of Arbitrum USDC custom gateway and ArbOS upgrade — {ext_link('https://docs.arbitrum.io/assets/files/2024_08_29_trail_of_bits_security_audit_usdc_custom_gateway_and_arbos_upgrade_at_timestamp_action-f490e6aa741551bfbf4b2349fcc82579.pdf', 'view audit report')}",
        f"<b>Hyperliquid (Zellic):</b> audit of Hyperliquid core infrastructure — {ext_link('https://2356094849-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FyUdp569E6w18GdfqlGvJ%2Fuploads%2FRhEpax5uWlJelxdFNb9c%2F2312%20Hyperliquid%20-%20Zellic%20Audit%20Report.pdf?alt=media', 'view audit report')}",
        f"<b>Privy Shamir Secret Sharing (Zellic):</b> audit of Privy embedded-wallet key-sharding architecture — {ext_link('https://github.com/Zellic/publications/blob/master/Privy_Shamir_Secret_Sharing_-_Zellic_Audit_Report.pdf', 'view audit report')}",
    ]))
    s.append(P(
        "<b>HyperTrade codebase anchors:</b> Privy embedded EOA + ERC-4337 smart wallet; External Wallet Access (URID, IBAN, balances, history); "
        "gasless EIP-7702 + Ambire Add Money and FX on Mantle; EIP-2612 permit relays for Hyperliquid deposits and UR.APP withdraw/payout; "
        f"dedicated {UR_APP} relayer pool with Supabase nonce locks; Hyperliquid API-wallet + builder-fee setup; frontend margin and liquidation guards; "
        "ai-agent-worker (leader-gated cycles, global market cache, multi-LLM brain, HL named-agent adapter); "
        f"Sumsub KYC via mobile SDK with verification outcomes only — no document storage on HyperTrade servers.",
        "Small",
    ))
    s.append(P(
        "<b>OrbCast codebase anchors:</b> Privy embedded EOA; HIP-4 trader client (venue-generic); "
        "EIP-2612 permit relays for USDC deposits; builder-fee setup; sports chrome is fixtures/score only — not venue odds. "
        "No perps, HIP-3, UR.APP banking, or AI worker in v1.",
        "Small",
    ))
    s.append(P("This document is not legal, investment, tax, or trading advice. Product roadmap items are forward-looking and subject to provider, regulatory, technical, and market constraints.", "Small"))
    return s


def markdown() -> str:
    return """# Lunatic Wisdom Labs Whitepaper

This is the editable companion source for `LWL_Whitepaper.pdf`.

## Core thesis

Lunatic Wisdom Labs LLC publishes open-source, onchain products that keep users in control of their keys. Live products are HyperTrade (trading + optional finance + optional AI agents) and OrbCast (HIP-4 outcome markets). One token: LWL. Buybacks and burns are funded from any LWL product revenue, at a dynamic share that is never less than 70%.

## Key themes

- Labs vision: AI & self-custody, open source, no intermediaries
- Product portfolio: HyperTrade, OrbCast; further work listed as in development
- HyperTrade: casual and advanced trading interface (technical depth from §4)
- OrbCast: HIP-4 outcomes / sports showcase; no perps, banking, or AI worker in v1
- Privy wallet onboarding and ERC-4337 smart-wallet path
- Arbitrum USDC and gasless permit relayers
- UR.APP integration (HyperTrade, optional): External Wallet Access, Fiat Only cards, Sumsub SDK KYC
- Custody boundary: wallet USDC / trading = non-custodial UI; USD24/EUR24 = UR.APP-regulated fiat tokens
- HIP-3 non-crypto books on HyperTrade; HIP-4 is OrbCast, not a HyperTrade tab
- SEC covered-user-interface regulatory context (§13)
- AI Trading Agents are HyperTrade-only
- LWL tokenomics (§11): 1B max supply, fair launch, locks unchanged, single token, ≥70% dynamic buyback/burn from any product revenue

Labs: https://www.lunaticwisdomlabs.com/
HyperTrade: https://github.com/LWL-HyperTrade/hypertrade
OrbCast: https://github.com/LWL-OrbCast/orbcast

The final PDF is generated by `generate_whitepaper_v2.py`.
"""


def main():
    doc = WhitepaperDoc(
        str(PDF_PATH),
        pagesize=A4,
        leftMargin=MARGIN_X,
        rightMargin=MARGIN_X,
        topMargin=1.55 * cm,
        bottomMargin=1.65 * cm,
        title="Lunatic Wisdom Labs Whitepaper",
        author="Lunatic Wisdom Labs LLC",
    )
    # Multi-pass until TOC page numbers stabilize (pass 2+ renders the full TOC block).
    toc_entries: List[tuple] | None = None
    last_pages: List[int] | None = None
    for _ in range(4):
        WhitepaperDoc.toc_entries = []
        doc.multiBuild(story(toc_entries), onFirstPage=bg, onLaterPages=bg)
        measured = list(WhitepaperDoc.toc_entries)
        pages = [page for _, _, page in measured]
        if last_pages is not None and pages == last_pages:
            break
        toc_entries = measured
        last_pages = pages
    MD_PATH.write_text(markdown(), encoding="utf-8")
    print(f"Wrote {PDF_PATH}")
    print(f"Wrote {MD_PATH}")


if __name__ == "__main__":
    main()
