# -*- coding: utf-8 -*-
"""Generate the complete client-facing dashboard onboarding PDF (Nexa branded).
Covers BOTH data sources: the conversation-log Google Sheet (required) and
GA4 (optional). Uses the real service-account email."""
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle,
    Image, HRFlowable, KeepTogether, PageBreak,
)
from reportlab.lib.utils import ImageReader

PURPLE      = colors.HexColor("#5053C8")
PURPLE_SOFT = colors.HexColor("#EEEEFB")
INK         = colors.HexColor("#1A1A2E")
MUTED       = colors.HexColor("#5B5B6B")
LINE        = colors.HexColor("#E4E4EF")
CODEBG      = colors.HexColor("#F4F4FB")
GREEN       = colors.HexColor("#1B9C6B")

SA_EMAIL = "convo-ai-sheets-reader@convo-ai-496805.iam.gserviceaccount.com"
LOGO = r"D:\dashboard\convo-ai\frontend\public\nexa-logo.png"
OUT  = r"D:\dashboard\convo-ai\docs\Convo-AI-Dashboard-Setup-Guide.pdf"

def S(name, **kw):
    base = dict(fontName="Helvetica", fontSize=10.5, leading=15.5, textColor=INK)
    base.update(kw); return ParagraphStyle(name, **base)

st_title   = S("title", fontName="Helvetica-Bold", fontSize=22, leading=26, spaceAfter=2)
st_sub     = S("sub", fontSize=11, textColor=PURPLE, fontName="Helvetica-Bold", spaceAfter=2)
st_eyebrow = S("eyebrow", fontSize=8.5, textColor=MUTED, fontName="Helvetica-Bold", spaceAfter=4)
st_body    = S("body", spaceAfter=7)
st_h2      = S("h2", fontName="Helvetica-Bold", fontSize=14, leading=18, spaceBefore=4, spaceAfter=6)
st_part    = S("part", fontName="Helvetica-Bold", fontSize=12, textColor=colors.white, leading=15)
st_part_t  = S("partt", fontName="Helvetica-Bold", fontSize=13.5, textColor=INK, leading=16)
st_part_s  = S("parts", fontSize=9.5, textColor=MUTED, leading=12.5)
st_step_n  = S("stepn", fontName="Helvetica-Bold", fontSize=11.5, textColor=colors.white, leading=14, alignment=1)
st_step_h  = S("steph", fontName="Helvetica-Bold", fontSize=11, leading=14.5, spaceAfter=2)
st_bullet  = S("bul", fontSize=10, leading=14.5, textColor=MUTED, leftIndent=10)
st_code    = S("code", fontName="Courier-Bold", fontSize=10, leading=14, textColor=PURPLE)
st_note_h  = S("noteh", fontName="Helvetica-Bold", fontSize=10, spaceAfter=3)
st_note_b  = S("noteb", fontSize=9.5, leading=14, textColor=MUTED)
st_th      = S("th", fontName="Helvetica-Bold", fontSize=9, textColor=colors.white, leading=12)
st_td      = S("td", fontSize=9, leading=12.5, fontName="Helvetica-Bold")
st_td_m    = S("tdm", fontSize=9, leading=12.5, textColor=MUTED)
st_foot    = S("foot", fontSize=8.5, textColor=MUTED)

story = []

# ---- helpers --------------------------------------------------------------
def step(num, head, body_flowables, tail=10):
    badge = Table([[Paragraph(num, st_step_n)]], colWidths=[8*mm], rowHeights=[8*mm])
    badge.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,-1), PURPLE),
        ("VALIGN", (0,0), (-1,-1), "MIDDLE"), ("ALIGN", (0,0), (-1,-1), "CENTER"),
        ("ROUNDEDCORNERS", [4,4,4,4]),
        ("TOPPADDING", (0,0), (-1,-1), 0), ("BOTTOMPADDING", (0,0), (-1,-1), 0),
    ]))
    right = [Paragraph(head, st_step_h)] + body_flowables
    row = Table([[badge, right]], colWidths=[12*mm, 148*mm])
    row.setStyle(TableStyle([
        ("VALIGN", (0,0), (-1,-1), "TOP"),
        ("LEFTPADDING", (1,0), (1,-1), 2),
        ("TOPPADDING", (0,0), (-1,-1), 0), ("BOTTOMPADDING", (0,0), (-1,-1), 0),
    ]))
    return KeepTogether([row, Spacer(1, tail)])

def callout(lines, accent=PURPLE):
    rows = [[Paragraph(t, s)] for t, s in lines]
    tb = Table(rows, colWidths=[148*mm])
    tb.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,-1), CODEBG),
        ("BOX", (0,0), (-1,-1), 0.8, LINE),
        ("LINEBEFORE", (0,0), (0,-1), 3, accent),
        ("LEFTPADDING", (0,0), (-1,-1), 10), ("RIGHTPADDING", (0,0), (-1,-1), 10),
        ("TOPPADDING", (0,0), (0,0), 8), ("BOTTOMPADDING", (0,-1), (-1,-1), 8),
        ("TOPPADDING", (0,1), (-1,-1), 2),
    ]))
    return tb

def part_banner(num, title, subtitle, required=True):
    badge = Table([[Paragraph(num, st_part)]], colWidths=[12*mm], rowHeights=[12*mm])
    badge.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,-1), PURPLE), ("VALIGN",(0,0),(-1,-1),"MIDDLE"),
        ("ALIGN",(0,0),(-1,-1),"CENTER"), ("ROUNDEDCORNERS",[5,5,5,5]),
    ]))
    tag_txt = "REQUIRED" if required else "OPTIONAL"
    tag_col = GREEN if required else MUTED
    tag = Table([[Paragraph(tag_txt, S("tg", fontName="Helvetica-Bold", fontSize=7.5,
                 textColor=colors.white, alignment=1))]], colWidths=[20*mm], rowHeights=[6*mm])
    tag.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,-1),tag_col),("VALIGN",(0,0),(-1,-1),"MIDDLE"),
                 ("ALIGN",(0,0),(-1,-1),"CENTER"),("ROUNDEDCORNERS",[3,3,3,3])]))
    txt = [Paragraph(title, st_part_t), Paragraph(subtitle, st_part_s)]
    row = Table([[badge, txt, tag]], colWidths=[14*mm, 104*mm, 22*mm])
    row.setStyle(TableStyle([("VALIGN",(0,0),(0,0),"MIDDLE"),("VALIGN",(1,0),(1,0),"MIDDLE"),
                 ("VALIGN",(2,0),(2,0),"MIDDLE"),
                 ("TOPPADDING",(0,0),(-1,-1),0),("BOTTOMPADDING",(0,0),(-1,-1),0)]))
    band = Table([[row]], colWidths=[160*mm])
    band.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,-1),PURPLE_SOFT),
                 ("LEFTPADDING",(0,0),(-1,-1),10),("RIGHTPADDING",(0,0),(-1,-1),10),
                 ("TOPPADDING",(0,0),(-1,-1),9),("BOTTOMPADDING",(0,0),(-1,-1),9),
                 ("ROUNDEDCORNERS",[6,6,6,6])]))
    return band

# ====================== PAGE 1 — cover + overview ==========================
ir = ImageReader(LOGO); iw, ih = ir.getSize()
logo_w = 38*mm
story += [Image(LOGO, width=logo_w, height=logo_w*ih/iw), Spacer(1,10),
          Paragraph("CLIENT ONBOARDING GUIDE", st_eyebrow),
          Paragraph("Setting Up Your Convo AI Dashboard", st_title),
          Paragraph("Conversational analytics  ·  by Nexa AI Lab", st_sub),
          Spacer(1,8), HRFlowable(width="100%", thickness=2, color=PURPLE, spaceAfter=12)]

story.append(Paragraph(
    "Your Convo&nbsp;AI dashboard turns your guest conversations &mdash; and, optionally, your website "
    "analytics &mdash; into a live, always-current dashboard. It reads from two sources, both granted to "
    "us with simple <b>read-only</b> access:", st_body))

st_card_t = S("cardt", fontName="Helvetica-Bold", fontSize=11.5, leading=15, textColor=INK, spaceAfter=2)
st_card_d = S("cardd", fontSize=9.5, leading=14, textColor=MUTED)

def _num_badge(num):
    t = Table([[Paragraph(num, st_step_n)]], colWidths=[9*mm], rowHeights=[9*mm])
    t.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,-1),PURPLE),("VALIGN",(0,0),(-1,-1),"MIDDLE"),
        ("ALIGN",(0,0),(-1,-1),"CENTER"),("ROUNDEDCORNERS",[4.5,4.5,4.5,4.5]),
        ("TOPPADDING",(0,0),(-1,-1),0),("BOTTOMPADDING",(0,0),(-1,-1),0),
        ("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0)]))
    return t

def _pill(txt, color):
    t = Table([[Paragraph(txt, S("pl", fontName="Helvetica-Bold", fontSize=8,
               textColor=colors.white, alignment=1))]], colWidths=[24*mm], rowHeights=[7*mm])
    t.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,-1),color),("VALIGN",(0,0),(-1,-1),"MIDDLE"),
        ("ALIGN",(0,0),(-1,-1),"CENTER"),("ROUNDEDCORNERS",[3.5,3.5,3.5,3.5]),
        ("TOPPADDING",(0,0),(-1,-1),0),("BOTTOMPADDING",(0,0),(-1,-1),0),
        ("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0)]))
    return t

def source_card(num, title, desc, tag, tag_color):
    textcol = [Paragraph(title, st_card_t), Paragraph(desc, st_card_d)]
    card = Table([[_num_badge(num), textcol, _pill(tag, tag_color)]],
                 colWidths=[15*mm, 113*mm, 32*mm])
    card.setStyle(TableStyle([
        ("VALIGN",(0,0),(-1,-1),"MIDDLE"),
        ("ALIGN",(2,0),(2,0),"RIGHT"),
        ("BACKGROUND",(0,0),(-1,-1),colors.white),
        ("BOX",(0,0),(-1,-1),0.8,LINE),
        ("ROUNDEDCORNERS",[7,7,7,7]),
        ("LEFTPADDING",(0,0),(0,0),11), ("RIGHTPADDING",(2,0),(2,0),11),
        ("LEFTPADDING",(1,0),(1,0),5), ("RIGHTPADDING",(1,0),(1,0),5),
        ("TOPPADDING",(0,0),(-1,-1),11), ("BOTTOMPADDING",(0,0),(-1,-1),11),
    ]))
    return card

story += [
    source_card("1", "Conversation log  (Google Sheet)",
        "The heart of the dashboard &mdash; every chat becomes volume, intent, "
        "sentiment, FAQ and guest-country analytics.", "REQUIRED", GREEN),
    Spacer(1,9),
    source_card("2", "Google Analytics 4",
        "Adds website traffic, devices and booking revenue. Connect it any "
        "time; the dashboard works without it.", "OPTIONAL", MUTED),
    Spacer(1,16),
]

# one service account note
story.append(Paragraph("One account for both", st_h2))
story.append(Paragraph("Wherever this guide asks you to grant access, use this single Nexa service-account "
    "address. It is read-only and used for both your Sheet and your GA4 property:", st_body))
story.append(callout([("Our service-account address &mdash; grant it <b>Viewer</b> access:", st_note_b),
                       (SA_EMAIL, st_code)]))
story += [Spacer(1,10),
          Paragraph("Everything else &mdash; building the dashboard, mapping your data, styling, refresh "
          "schedule &mdash; is done by us. You don't need a Google Cloud account or any technical setup.", st_note_b)]

story.append(PageBreak())

# ====================== PAGE 2 — Part 1: the Sheet =========================
story.append(part_banner("1", "Connect your conversation data", "Google Sheet  ·  the dashboard's core data source", required=True))
story.append(Spacer(1,12))

# schema table
story.append(Paragraph("a.  Your sheet's layout", st_step_h))
story.append(Paragraph("Your conversation log should live in one tab named <b>Chat Logs</b>, with a header "
    "row in row&nbsp;1 and one row per message. We read these columns by their header name &mdash; please keep "
    "the spelling as below (Timestamp first, in column&nbsp;A):", st_bullet))
story.append(Spacer(1,6))
schema = [
    [Paragraph("Column header", st_th), Paragraph("What it holds", st_th)],
    [Paragraph("Timestamp", st_td), Paragraph("Date &amp; time of the message (column A)", st_td_m)],
    [Paragraph("Session ID", st_td), Paragraph("Groups messages into one conversation", st_td_m)],
    [Paragraph("Role", st_td), Paragraph("Who sent it &mdash; <font face='Courier'>user</font> or <font face='Courier'>assistant</font>", st_td_m)],
    [Paragraph("Content", st_td), Paragraph("The message text itself", st_td_m)],
    [Paragraph("Source", st_td), Paragraph("Where the chat came from (e.g. app, web, WhatsApp)", st_td_m)],
    [Paragraph("User Name", st_td), Paragraph("Guest name, if known", st_td_m)],
    [Paragraph("User Email", st_td), Paragraph("Guest email, if known", st_td_m)],
    [Paragraph("User Phone", st_td), Paragraph("Guest phone &mdash; used to map guest countries", st_td_m)],
]
sc = Table(schema, colWidths=[42*mm, 118*mm])
sc.setStyle(TableStyle([
    ("BACKGROUND",(0,0),(-1,0),PURPLE),
    ("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white, PURPLE_SOFT]),
    ("LINEBELOW",(0,0),(-1,-1),0.5,LINE),
    ("VALIGN",(0,0),(-1,-1),"MIDDLE"),
    ("TOPPADDING",(0,0),(-1,-1),6),("BOTTOMPADDING",(0,0),(-1,-1),6),
    ("LEFTPADDING",(0,0),(-1,-1),10),
]))
story += [sc, Spacer(1,8)]
story.append(callout([("Already have a sheet with different headers or layout? No need to rebuild it &mdash; "
    "just send it over and we'll map your columns to the dashboard for you.", st_note_b)]))
story.append(Spacer(1,14))

story.append(Paragraph("b.  Share it with us &amp; send the link", st_step_h))
story.append(step("1", "Open your Google Sheet and click <b>Share</b> (top right)", [
    Paragraph("Paste our service-account address into the people field:", st_bullet, bulletText="•"),
    Spacer(1,4), callout([(SA_EMAIL, st_code)]),
], tail=8))
story.append(step("2", "Set the role to <b>Viewer</b> and click <b>Send</b>", [
    Paragraph("Viewer is read-only &mdash; we can see the data but never change your sheet.", st_bullet, bulletText="•"),
    Paragraph("You can untick &ldquo;Notify people&rdquo; &mdash; the service account doesn't read email.", st_bullet, bulletText="•"),
], tail=8))
story.append(step("3", "Send us the sheet link", [
    Paragraph("Copy the URL from your browser's address bar and send it to us. That's all we need to "
              "connect your conversation data.", st_bullet, bulletText="•"),
]))

story.append(PageBreak())

# ====================== PAGE 3 — Part 2: GA4 ==============================
story.append(part_banner("2", "Connect Google Analytics 4", "Adds traffic, devices, guest countries &amp; booking revenue", required=False))
story.append(Spacer(1,12))
story.append(Paragraph("This step is optional and can be done any time. When connected, your dashboard also "
    "shows website visitors, traffic sources, device split, and booking revenue pulled straight from GA4.", st_body))
story.append(Spacer(1,4))

story.append(step("1", "Find your GA4 Property ID", [
    Paragraph("In Google Analytics, click <b>Admin</b> (gear icon, bottom-left).", st_bullet, bulletText="•"),
    Paragraph("Open <b>Property Settings</b> and copy the <b>Property ID</b> &mdash; a 9-digit number "
              "(e.g. 345678901), <i>not</i> the G-XXXXXXX measurement ID.", st_bullet, bulletText="•"),
], tail=10))
story.append(step("2", "Grant us read-only access", [
    Paragraph("In <b>Admin</b>, open <b>Property Access Management</b>.", st_bullet, bulletText="•"),
    Paragraph("Click <b>+</b> (top right) &rarr; <b>Add users</b>, enter the address below, set role to "
              "<b>Viewer</b>, and click <b>Add</b>:", st_bullet, bulletText="•"),
    Spacer(1,4), callout([(SA_EMAIL, st_code)]),
], tail=10))
story.append(step("3", "Tell us your conversion event", [
    Paragraph("Send us the exact GA4 event name that represents a booking/purchase "
              "(e.g. <font face='Courier'>purchase</font>, <font face='Courier'>booking_confirmed</font>).", st_bullet, bulletText="•"),
    Paragraph("Not sure? We'll default to <font face='Courier'>purchase</font> and adjust later.", st_bullet, bulletText="•"),
]))

story.append(Spacer(1,10))
story.append(Paragraph("What happens next", st_h2))
story.append(Paragraph("Once we have your sheet link (and, if you want it, your GA4 details), we connect "
    "everything on our side and your dashboard goes live &mdash; refreshing automatically from then on. "
    "Conversation data updates continuously; GA4 metrics refresh on a regular schedule.", st_body))

# quick reference
story.append(Paragraph("Quick reference", st_h2))
ref = [
    [Paragraph("What we need", st_th), Paragraph("How", st_th)],
    [Paragraph("Conversation sheet shared", st_td), Paragraph("Share with the service account as <b>Viewer</b>, send us the link", st_td_m)],
    [Paragraph("(Optional) GA4 Property ID", st_td), Paragraph("Admin &rarr; Property Settings", st_td_m)],
    [Paragraph("(Optional) GA4 access", st_td), Paragraph("Admin &rarr; Property Access Management &rarr; add as Viewer", st_td_m)],
    [Paragraph("(Optional) Conversion event", st_td), Paragraph("Your GA4 event name, e.g. <font face='Courier'>purchase</font>", st_td_m)],
]
rt = Table(ref, colWidths=[55*mm, 105*mm])
rt.setStyle(TableStyle([
    ("BACKGROUND",(0,0),(-1,0),PURPLE),
    ("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white, PURPLE_SOFT]),
    ("LINEBELOW",(0,0),(-1,-1),0.5,LINE), ("VALIGN",(0,0),(-1,-1),"MIDDLE"),
    ("TOPPADDING",(0,0),(-1,-1),7),("BOTTOMPADDING",(0,0),(-1,-1),7),
    ("LEFTPADDING",(0,0),(-1,-1),10),
]))
story += [rt, Spacer(1,10)]

note = Table([[[
    Paragraph("Good to know &amp; security", st_note_h),
    Paragraph("&bull;&nbsp; We only ever request <b>read-only (Viewer)</b> access &mdash; we can never edit your data.", st_note_b),
    Paragraph("&bull;&nbsp; GA4 must be a <b>GA4</b> property (not the older Universal Analytics).", st_note_b),
    Paragraph("&bull;&nbsp; Revenue is shown in your GA4 property's currency; the dashboard labels it AED, so if "
              "your property uses another currency the value is right but the label may differ &mdash; tell us and we'll adjust.", st_note_b),
    Paragraph("&bull;&nbsp; You can revoke our access at any time from Google Sheets or GA4.", st_note_b),
]]], colWidths=[160*mm])
note.setStyle(TableStyle([
    ("BACKGROUND",(0,0),(-1,-1),PURPLE_SOFT), ("LINEBEFORE",(0,0),(0,-1),3,PURPLE),
    ("LEFTPADDING",(0,0),(-1,-1),12),("RIGHTPADDING",(0,0),(-1,-1),12),
    ("TOPPADDING",(0,0),(-1,-1),10),("BOTTOMPADDING",(0,0),(-1,-1),10),
]))
story.append(note)

# ---- page deco ------------------------------------------------------------
def deco(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8.5); canvas.setFillColor(MUTED)
    canvas.drawString(20*mm, 12*mm, "Nexa AI Lab  ·  Convo AI")
    canvas.drawRightString(190*mm, 12*mm, "Need help? Just reply to your onboarding email.")
    canvas.drawCentredString(105*mm, 12*mm, f"Page {doc.page}")
    canvas.setStrokeColor(LINE); canvas.setLineWidth(0.6)
    canvas.line(20*mm, 15*mm, 190*mm, 15*mm)
    canvas.restoreState()

doc = BaseDocTemplate(OUT, pagesize=A4, leftMargin=20*mm, rightMargin=20*mm,
                      topMargin=18*mm, bottomMargin=20*mm,
                      title="Setting Up Your Convo AI Dashboard", author="Nexa AI Lab")
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=deco)])
doc.build(story)
print("WROTE", OUT)
