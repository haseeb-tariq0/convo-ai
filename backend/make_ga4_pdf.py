# -*- coding: utf-8 -*-
"""Generate the client-facing GA4 onboarding PDF (Nexa AI Lab branded)."""
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle,
    Image, HRFlowable, KeepTogether,
)

PURPLE = colors.HexColor("#5053C8")
PURPLE_SOFT = colors.HexColor("#EEEEFB")
INK = colors.HexColor("#1A1A2E")
MUTED = colors.HexColor("#5B5B6B")
LINE = colors.HexColor("#E4E4EF")
CODEBG = colors.HexColor("#F4F4FB")

LOGO = r"D:\dashboard\convo-ai\frontend\public\nexa-logo.png"
OUT = r"D:\dashboard\convo-ai\docs\GA4-Setup-Guide.pdf"

# ---- styles ---------------------------------------------------------------
def S(name, **kw):
    base = dict(fontName="Helvetica", fontSize=10.5, leading=15.5, textColor=INK)
    base.update(kw)
    return ParagraphStyle(name, **base)

st_title    = S("title", fontName="Helvetica-Bold", fontSize=23, leading=27, textColor=INK, spaceAfter=2)
st_sub      = S("sub", fontSize=11, textColor=PURPLE, fontName="Helvetica-Bold", spaceAfter=2)
st_eyebrow  = S("eyebrow", fontSize=8.5, textColor=MUTED, fontName="Helvetica-Bold", spaceAfter=4)
st_body     = S("body", spaceAfter=7)
st_h2       = S("h2", fontName="Helvetica-Bold", fontSize=13.5, leading=17, textColor=INK, spaceBefore=6, spaceAfter=6)
st_step_n   = S("stepn", fontName="Helvetica-Bold", fontSize=12, textColor=colors.white, leading=14, alignment=1)
st_step_h   = S("steph", fontName="Helvetica-Bold", fontSize=11.5, leading=15, textColor=INK, spaceAfter=2)
st_step_b   = S("stepb", fontSize=10, leading=14.5, textColor=MUTED)
st_bullet   = S("bul", fontSize=10, leading=14.5, textColor=MUTED, leftIndent=10, bulletIndent=0)
st_code     = S("code", fontName="Courier-Bold", fontSize=9.5, leading=13, textColor=PURPLE)
st_note_h   = S("noteh", fontName="Helvetica-Bold", fontSize=10, textColor=INK, spaceAfter=3)
st_note_b   = S("noteb", fontSize=9.5, leading=14, textColor=MUTED)
st_th       = S("th", fontName="Helvetica-Bold", fontSize=9.5, textColor=colors.white)
st_td       = S("td", fontSize=9.5, leading=13, textColor=INK)
st_td_m     = S("tdm", fontSize=9.5, leading=13, textColor=MUTED)
st_foot     = S("foot", fontSize=8.5, textColor=MUTED)

story = []

# ---- header band ----------------------------------------------------------
from reportlab.lib.utils import ImageReader
ir = ImageReader(LOGO)
iw, ih = ir.getSize()
logo_w = 38 * mm
logo_h = logo_w * ih / iw
story.append(Image(LOGO, width=logo_w, height=logo_h))
story.append(Spacer(1, 10))
story.append(Paragraph("INTEGRATION SETUP GUIDE", st_eyebrow))
story.append(Paragraph("Connecting Google Analytics 4", st_title))
story.append(Paragraph("Convo AI dashboards  ·  by Nexa AI Lab", st_sub))
story.append(Spacer(1, 8))
story.append(HRFlowable(width="100%", thickness=2, color=PURPLE, spaceAfter=12))

story.append(Paragraph(
    "This guide walks you through connecting your Google Analytics 4 (GA4) property to your "
    "Convo&nbsp;AI dashboard. Once connected, your dashboard automatically pulls visitor, traffic, "
    "device, country and booking-revenue metrics from GA4 &mdash; refreshed for you on a schedule, "
    "with no manual exports. The whole process takes about <b>5 minutes</b> and only requires "
    "read-only access.", st_body))

# ---- what we need ---------------------------------------------------------
story.append(Spacer(1, 4))
story.append(Paragraph("What we need from you", st_h2))

need_rows = [
    ["1", "<b>Your GA4 Property ID</b><br/>A 9-digit number (e.g. 345678901) &mdash; not the G-XXXXXXX measurement ID."],
    ["2", "<b>Read-only access</b> for our service account on your GA4 property (we send you the exact email address)."],
    ["3", "<b>Your booking / conversion event name</b> (e.g. <font face='Courier'>purchase</font>) &mdash; or we default to <font face='Courier'>purchase</font>."],
]
data = [[Paragraph(n, st_step_n), Paragraph(t, st_step_b)] for n, t in need_rows]
t = Table(data, colWidths=[10*mm, 150*mm])
t.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (0,-1), PURPLE),
    ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
    ("TOPPADDING", (0,0), (-1,-1), 8),
    ("BOTTOMPADDING", (0,0), (-1,-1), 8),
    ("LEFTPADDING", (1,0), (1,-1), 10),
    ("ROUNDEDCORNERS", [3,3,3,3]),
    ("LINEBELOW", (1,0), (1,-2), 0.6, LINE),
]))
story.append(t)
story.append(Spacer(1, 16))

# ---- the steps ------------------------------------------------------------
story.append(Paragraph("Step-by-step", st_h2))

def step(num, head, body_flowables):
    badge = Table([[Paragraph(num, st_step_n)]], colWidths=[8*mm], rowHeights=[8*mm])
    badge.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,-1), PURPLE),
        ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
        ("ALIGN", (0,0), (-1,-1), "CENTER"),
        ("ROUNDEDCORNERS", [4,4,4,4]),
        ("TOPPADDING", (0,0), (-1,-1), 0),
        ("BOTTOMPADDING", (0,0), (-1,-1), 0),
    ]))
    right = [Paragraph(head, st_step_h)] + body_flowables
    row = Table([[badge, right]], colWidths=[12*mm, 148*mm])
    row.setStyle(TableStyle([
        ("VALIGN", (0,0), (-1,-1), "TOP"),
        ("LEFTPADDING", (1,0), (1,-1), 2),
        ("TOPPADDING", (0,0), (-1,-1), 0),
        ("BOTTOMPADDING", (0,0), (-1,-1), 0),
    ]))
    return KeepTogether([row, Spacer(1, 12)])

story.append(step("1", "Find your GA4 Property ID", [
    Paragraph("In Google Analytics, click <b>Admin</b> (the gear icon, bottom-left).", st_bullet, bulletText="•"),
    Paragraph("Open <b>Property Settings</b>.", st_bullet, bulletText="•"),
    Paragraph("Copy the <b>Property ID</b> &mdash; the 9-digit number shown at the top right.", st_bullet, bulletText="•"),
]))

# callout: service account email
sa = Table([[Paragraph("We will email you this exact address &mdash; paste it in the next step:", st_note_b)],
            [Paragraph("your-service-account@nexa-project.iam.gserviceaccount.com", st_code)]],
           colWidths=[148*mm])
sa.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,-1), CODEBG),
    ("BOX", (0,0), (-1,-1), 0.8, LINE),
    ("LEFTPADDING", (0,0), (-1,-1), 10), ("RIGHTPADDING", (0,0), (-1,-1), 10),
    ("TOPPADDING", (0,0), (0,0), 8), ("BOTTOMPADDING", (0,-1), (-1,-1), 8),
    ("TOPPADDING", (0,1), (-1,1), 2),
    ("LINEBEFORE", (0,0), (0,-1), 3, PURPLE),
]))

story.append(step("2", "Grant us read-only access", [
    Paragraph("In <b>Admin</b>, open <b>Property Access Management</b>.", st_bullet, bulletText="•"),
    Paragraph("Click the <b>+</b> button (top right) &rarr; <b>Add users</b>.", st_bullet, bulletText="•"),
    Paragraph("Enter our service-account email (below) and set the role to <b>Viewer</b>.", st_bullet, bulletText="•"),
    Paragraph("Click <b>Add</b>. That's it &mdash; Viewer is read-only; we can never edit your analytics.", st_bullet, bulletText="•"),
    Spacer(1, 6),
    sa,
]))

story.append(step("3", "Tell us your conversion event", [
    Paragraph("If you track bookings/purchases as a GA4 event, send us its <b>exact name</b> "
              "(e.g. <font face='Courier'>purchase</font>, <font face='Courier'>booking_confirmed</font>).", st_bullet, bulletText="•"),
    Paragraph("Not sure? No problem &mdash; we'll use <font face='Courier'>purchase</font> by default and adjust later.", st_bullet, bulletText="•"),
]))

# ---- what happens next ----------------------------------------------------
story.append(HRFlowable(width="100%", thickness=0.8, color=LINE, spaceBefore=2, spaceAfter=12))
story.append(Paragraph("What happens next", st_h2))
story.append(Paragraph(
    "Send us the Property ID and confirm access is granted. We connect everything on our side &mdash; "
    "you don't need a Google Cloud account or any technical setup. Your dashboard begins showing GA4 "
    "metrics (active users, traffic sources, devices, guest countries and booking revenue) within the "
    "first sync, and refreshes automatically from then on.", st_body))

# ---- reference table ------------------------------------------------------
story.append(Spacer(1, 4))
story.append(Paragraph("Quick reference", st_h2))
ref = [
    [Paragraph("What", st_th), Paragraph("Example", st_th), Paragraph("Where to find it", st_th)],
    [Paragraph("GA4 Property ID", st_td), Paragraph("345678901", st_td_m), Paragraph("Admin &rarr; Property Settings", st_td_m)],
    [Paragraph("Grant Viewer access", st_td), Paragraph("our …iam.gserviceaccount.com email", st_td_m), Paragraph("Admin &rarr; Property Access Management", st_td_m)],
    [Paragraph("Conversion event", st_td), Paragraph("purchase", st_td_m), Paragraph("Your GA4 Events / your web team", st_td_m)],
]
rt = Table(ref, colWidths=[42*mm, 50*mm, 68*mm])
rt.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,0), PURPLE),
    ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.white, PURPLE_SOFT]),
    ("LINEBELOW", (0,0), (-1,-1), 0.5, LINE),
    ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
    ("TOPPADDING", (0,0), (-1,-1), 7), ("BOTTOMPADDING", (0,0), (-1,-1), 7),
    ("LEFTPADDING", (0,0), (-1,-1), 10),
]))
story.append(rt)
story.append(Spacer(1, 14))

# ---- good to know ---------------------------------------------------------
note = Table([[ [Paragraph("Good to know", st_note_h),
    Paragraph("&bull;&nbsp; This must be a <b>GA4</b> property (not the older Universal Analytics).", st_note_b),
    Paragraph("&bull;&nbsp; We only ever request <b>read-only (Viewer)</b> access.", st_note_b),
    Paragraph("&bull;&nbsp; Revenue is shown in your GA4 property's own currency; the dashboard labels it AED, "
              "so if your property is set to another currency the value is correct but the label may differ &mdash; tell us and we'll adjust.", st_note_b),
] ]], colWidths=[160*mm])
note.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,-1), PURPLE_SOFT),
    ("LEFTPADDING", (0,0), (-1,-1), 12), ("RIGHTPADDING", (0,0), (-1,-1), 12),
    ("TOPPADDING", (0,0), (-1,-1), 10), ("BOTTOMPADDING", (0,0), (-1,-1), 10),
    ("LINEBEFORE", (0,0), (0,-1), 3, PURPLE),
]))
story.append(note)

# ---- frame / page deco ----------------------------------------------------
def deco(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(20*mm, 12*mm, "Nexa AI Lab  ·  Convo AI")
    canvas.drawRightString(190*mm, 12*mm, "Need help? Just reply to your onboarding email.")
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.6)
    canvas.line(20*mm, 15*mm, 190*mm, 15*mm)
    canvas.restoreState()

doc = BaseDocTemplate(OUT, pagesize=A4,
                      leftMargin=20*mm, rightMargin=20*mm,
                      topMargin=18*mm, bottomMargin=20*mm,
                      title="Connecting Google Analytics 4 — Convo AI", author="Nexa AI Lab")
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=deco)])
doc.build(story)
print("WROTE", OUT)
