"""
Generate the 8 fictional demo bills in public/samples/.

Each bill maps to one demo scenario (see design.md "Demo Scenario Verification"):
  ready-1..4   -> no flags
  duplicate    -> same vendor + invoice number as seeded MAR-002
  overcharge   -> Apex Fuel $450 (> 2x the $200 average)
  new-payee    -> vendor not in the seed data
  needs-review -> blurred, handwritten-style bill (low AI confidence)

All businesses, addresses and emails are fictional. Every bill is marked SAMPLE.
Usage:  python scripts/generate-sample-bills.py
"""
from pathlib import Path
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).resolve().parent.parent / "public" / "samples"
FONTS = Path("C:/Windows/Fonts")
W, H = 850, 1100
BILL_TO = ["Ridgeway Fleet Services", "Attn: Accounts Payable", "18 Depot Road, Springfield"]


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    for candidate in (name, "arial.ttf"):
        try:
            return ImageFont.truetype(str(FONTS / candidate), size)
        except OSError:
            continue
    return ImageFont.load_default()


def money(cents: int) -> str:
    return f"{cents // 100:,}.{cents % 100:02d}"


BILLS = [
    dict(file="ready-1.jpg", vendor="ProParts Supply", tagline="Truck & Trailer Parts", accent=(31, 97, 141),
         address="402 Industrial Pkwy, Springfield", email="sb-e47hn753774321@personal.example.com", invoice="PPS-104",
         date="Nov 2, 2026", items=[("Brake pads (heavy duty)", "2", 12000), ("Oil filter", "4", 2000)]),
    dict(file="ready-2.jpg", vendor="Driver Direct Ltd", tagline="Relief Drivers on Demand", accent=(46, 125, 50),
         address="77 Harbor Lane, Springfield", email="sb-ar7jz53774080@personal.example.com", invoice="DDL-104",
         date="Nov 3, 2026", items=[("Relief driver shift - Route 12 (8 hrs)", "1", 16000)]),
    dict(file="ready-3.jpg", vendor="City Lube Stn.", tagline="Quick Oil & Fluids", accent=(198, 40, 40),
         address="9 Main St, Springfield", email="sb-61zd753774053@personal.example.com", invoice="CLS-104",
         date="Nov 3, 2026", items=[("Synthetic oil change", "1", 6500), ("Wiper fluid top-up", "1", 2500)]),
    dict(file="ready-4.jpg", vendor="Apex Fuel Company", tagline="Diesel - Fleet Accounts", accent=(230, 81, 0),
         address="Exit 14, Interstate 5, Springfield", email="sb-ar7jz53774080@personal.example.com", invoice="APX-104",
         date="Nov 4, 2026", items=[("Diesel (52.5 gal @ $4.00)", "1", 21000)]),
    dict(file="duplicate.jpg", vendor="Metro Auto Repair", tagline="Fleet Maintenance Specialists", accent=(69, 39, 160),
         address="250 Garage Row, Springfield", email="sb-61zd753774053@personal.example.com", invoice="MAR-002",
         date="Mar 30, 2026", items=[("Transmission service", "1", 65000), ("Labor (3 hrs @ $90.00)", "1", 27000)]),
    dict(file="overcharge.jpg", vendor="Apex Fuel Co", tagline="Diesel - Fleet Accounts", accent=(230, 81, 0),
         address="Exit 14, Interstate 5, Springfield", email="sb-ar7jz53774080@personal.example.com", invoice="APX-105",
         date="Nov 5, 2026", items=[("Diesel (112.5 gal @ $4.00)", "1", 45000)]),
    dict(file="new-payee.jpg", vendor="Highway Diesel Inc", tagline="24/7 Truck Stop Fuel", accent=(0, 121, 107),
         address="Mile 212, Route 66, Kingman", email="sb-e47hn753774321@personal.example.com", invoice="HD-0001",
         date="Nov 5, 2026", items=[("Diesel (18.75 gal @ $4.00)", "1", 7500)]),
]


def draw_typed_bill(b: dict) -> Image.Image:
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    accent = b["accent"]

    d.rectangle([0, 0, W, 14], fill=accent)
    d.text((60, 50), b["vendor"], font=font("arialbd.ttf", 40), fill=accent)
    d.text((60, 102), b["tagline"], font=font("ariali.ttf", 20), fill=(90, 90, 90))
    d.text((60, 132), b["address"], font=font("arial.ttf", 18), fill=(60, 60, 60))

    d.text((W - 60, 50), "INVOICE", font=font("arialbd.ttf", 34), fill=(30, 30, 30), anchor="ra")
    d.text((W - 60, 100), f"Invoice #: {b['invoice']}", font=font("arial.ttf", 20), fill=(30, 30, 30), anchor="ra")
    d.text((W - 60, 128), f"Date: {b['date']}", font=font("arial.ttf", 20), fill=(30, 30, 30), anchor="ra")

    y = 200
    d.text((60, y), "BILL TO", font=font("arialbd.ttf", 16), fill=(120, 120, 120))
    for i, line in enumerate(BILL_TO):
        d.text((60, y + 26 + i * 24), line, font=font("arial.ttf", 19), fill=(40, 40, 40))

    y = 330
    d.rectangle([60, y, W - 60, y + 40], fill=(242, 242, 242))
    hdr = font("arialbd.ttf", 17)
    d.text((75, y + 10), "Description", font=hdr, fill=(50, 50, 50))
    d.text((520, y + 10), "Qty", font=hdr, fill=(50, 50, 50))
    d.text((W - 75, y + 10), "Amount (USD)", font=hdr, fill=(50, 50, 50), anchor="ra")

    total = 0
    y += 55
    row = font("arial.ttf", 19)
    for desc, qty, unit_cents in b["items"]:
        line_total = unit_cents * int(qty)
        total += line_total
        d.text((75, y), desc, font=row, fill=(30, 30, 30))
        d.text((525, y), qty, font=row, fill=(30, 30, 30))
        d.text((W - 75, y), f"${money(line_total)}", font=row, fill=(30, 30, 30), anchor="ra")
        y += 38
        d.line([60, y - 8, W - 60, y - 8], fill=(225, 225, 225), width=1)

    y += 20
    d.line([480, y, W - 60, y], fill=(30, 30, 30), width=2)
    d.text((500, y + 18), "TOTAL DUE", font=font("arialbd.ttf", 24), fill=(30, 30, 30))
    d.text((W - 75, y + 16), f"${money(total)}", font=font("arialbd.ttf", 28), fill=accent, anchor="ra")
    d.text((500, y + 58), "Currency: USD", font=font("arial.ttf", 16), fill=(110, 110, 110))

    y = 820
    d.rectangle([60, y, W - 60, y + 90], outline=accent, width=2)
    d.text((80, y + 16), "PAYMENT", font=font("arialbd.ttf", 16), fill=accent)
    d.text((80, y + 44), f"Pay via PayPal: {b['email']}", font=font("arial.ttf", 20), fill=(30, 30, 30))
    d.text((W - 80, y + 44), "Due on receipt", font=font("ariali.ttf", 18), fill=(90, 90, 90), anchor="ra")

    d.text((W // 2, H - 60), "Thank you for your business.", font=font("ariali.ttf", 18), fill=(120, 120, 120), anchor="ma")
    d.text((W // 2, H - 32), "SAMPLE - fictional bill for the FleetSpend AI demo", font=font("arial.ttf", 13),
           fill=(170, 170, 170), anchor="ma")
    return img


def draw_needs_review() -> Image.Image:
    """A crumpled, handwritten-style receipt photo with a smudged total and date."""
    random.seed(7)
    paper = (238, 232, 214)
    img = Image.new("RGB", (W, H), paper)
    d = ImageDraw.Draw(img)
    hand = font("segoepr.ttf", 30)       # Segoe Print, handwriting style (falls back to Arial)
    hand_big = font("segoepr.ttf", 40)
    ink = (40, 52, 110)

    d.text((70, 60), "Metro Auto Repair", font=font("arialbd.ttf", 34), fill=(70, 70, 70))
    d.text((70, 105), "250 Garage Row, Springfield", font=font("arial.ttf", 18), fill=(90, 90, 90))
    d.text((70, 170), "Cash / Counter Receipt", font=font("arialbd.ttf", 22), fill=(70, 70, 70))

    d.text((70, 230), "No.", font=hand, fill=ink)
    d.text((140, 228), "MAR-1?7", font=hand, fill=ink)
    d.text((470, 230), "Date:", font=hand, fill=ink)
    d.text((570, 228), "11/0?/26", font=hand, fill=ink)

    d.text((70, 320), "Tow + roadside fix (unit 14)", font=hand, fill=ink)
    d.text((70, 380), "parts - see attached", font=hand, fill=ink)
    d.line([70, 470, W - 70, 470], fill=(120, 120, 120), width=2)
    d.text((70, 500), "Total", font=hand_big, fill=ink)
    d.text((470, 495), "$ 3?8.50", font=hand_big, fill=ink)
    d.text((70, 600), "paid?  ______", font=hand, fill=ink)
    d.text((W // 2, H - 40), "SAMPLE - fictional bill for the FleetSpend AI demo", font=font("arial.ttf", 13),
           fill=(150, 150, 150), anchor="ma")

    # Smudge the total and the date, then make the whole thing look like a poor phone photo.
    for box in [(440, 480, 800, 570), (540, 215, 790, 280)]:
        region = img.crop(box).filter(ImageFilter.GaussianBlur(6))
        img.paste(region, box)
    for _ in range(3500):  # paper noise
        x, y = random.randrange(W), random.randrange(H)
        shade = random.randint(190, 230)
        d.point((x, y), fill=(shade, shade - 6, shade - 20))
    img = img.filter(ImageFilter.GaussianBlur(1.4))
    img = img.rotate(4, expand=True, fillcolor=(60, 60, 60))
    return img.resize((W, int(H * 1.04)))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for b in BILLS:
        draw_typed_bill(b).save(OUT / b["file"], "JPEG", quality=88)
        print("wrote", b["file"])
    draw_needs_review().save(OUT / "needs-review.jpg", "JPEG", quality=70)
    print("wrote needs-review.jpg")


if __name__ == "__main__":
    main()
