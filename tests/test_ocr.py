"""OCR for photographed receipts: receipt text parsing (always) and real Tesseract OCR (when installed)."""

from __future__ import annotations

import importlib.util
import io
import unittest

from tutupbuku.extract import ExtractionError, extract_document
from tutupbuku.ocr import available, parse_receipt

HAVE_PIL = importlib.util.find_spec("PIL") is not None

RECEIPT = """ZUS COFFEE
Zus Coffee Sdn Bhd (1294562-T)
SST ID: W10-1808-31002345
Receipt No: ZUS - KCH-004871
Date: 14/10/ 2026 15:42
2 x Spanish Latte RM 25.80
1 x Americano RM 9.90
2 x Butter Croissant RM 15.80
Subtotal RM 51.50
SST 6% RM 3.09
Rounding -RM 0.04
TOTAL RM 54.55
Paid by Card RM 54.55
"""


def fields(result: dict) -> dict:
    return {f["key"]: f.get("sen", f["value"]) for f in result["fields"]}


class ReceiptParsingTests(unittest.TestCase):
    def test_receipt_fields_and_items(self) -> None:
        result = parse_receipt(RECEIPT)
        self.assertEqual(fields(result), {"receipt_ref": "ZUS-KCH-004871", "date": "2026-10-14", "merchant": "Zus Coffee Sdn Bhd", "total": 5455, "tax": 309})
        self.assertEqual([(l["quantity"], l["description"], l["unitSen"], l["totalSen"]) for l in result["lines"]],
                         [(2, "Spanish Latte", 1290, 2580), (1, "Americano", 990, 990), (2, "Butter Croissant", 790, 1580)])
        self.assertEqual(result["warnings"], [])

    def test_two_line_items_options_quantity_column_and_zero_lines(self) -> None:
        # Layout of a Zus delivery receipt: product name, then its options with quantity and price.
        text = ("ZUS COFFEE oRoER\nZuspresso (M) Sdn Bhd (1340330-X)\nInvoice Number: 26101057395\nDate: 10 Oct 2026, 01:41 PM\n"
                "Item Quantity Price\nIced Americano\nCronk 1 RM 6.90\nIced Roasted Hazelnut Latté\nDairy, Regular Sweet, BOSS 1 RM 11.90\n"
                "Iced Pistachio Cafe Latté 1 RM 12.90\nLess Sweet *\nVoucher - RM 0.00\nDelivery Fee RM 0.00\nGrand Total RM 31.70\nSST 6% (RM 1.79)")
        result = parse_receipt(text)
        self.assertEqual(fields(result)["merchant"], "Zuspresso (M) Sdn Bhd")
        self.assertEqual([(l["quantity"], l["description"], l["totalSen"]) for l in result["lines"]],
                         [(1, "Iced Americano (Cronk)", 690), (1, "Iced Roasted Hazelnut Latté (Dairy, Regular Sweet, BOSS)", 1190), (1, "Iced Pistachio Cafe Latté", 1290)])
        self.assertEqual((fields(result)["total"], fields(result)["tax"], result["warnings"]), (3170, 179, []))

    def test_the_total_line_wins_over_subtotal_and_payment_lines(self) -> None:
        self.assertEqual(fields(parse_receipt("Shop\nItem A 10.00\nSUBTOTAL 10.00\nGRAND TOTAL 10.60\nCASH 20.00\nCHANGE 9.40"))["total"], 1060)

    def test_misread_values_are_flagged_not_trusted(self) -> None:
        misread = RECEIPT.replace("1 x Americano RM 9.90", "4 x Americano RM 9.98").replace("14/10/ 2026", "14/10/2826")
        result = parse_receipt(misread)
        total = next(f for f in result["fields"] if f["key"] == "total")
        self.assertLess(total["confidence"], 0.7)  # the items no longer add up to the total
        self.assertNotIn("date", fields(result))  # an impossible year is not shown as a date
        self.assertIn("Receipt date not found.", result["warnings"])

    def test_date_formats(self) -> None:
        for text, iso in (("Date 2026-10-14", "2026-10-14"), ("14.10.26", "2026-10-14"), ("14 Oct 2026", "2026-10-14"), ("Oct 14, 2026", "2026-10-14")):
            with self.subTest(text=text):
                self.assertEqual(fields(parse_receipt(f"Shop\n{text}\nTOTAL 5.00"))["date"], iso)


@unittest.skipUnless(HAVE_PIL and available(), "Tesseract or Pillow is not installed")
class TesseractTests(unittest.TestCase):
    @staticmethod
    def image(lines: list[str], fmt: str = "PNG") -> bytes:
        from PIL import Image, ImageDraw, ImageFont
        try:
            font = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 24)
        except OSError:
            font = ImageFont.load_default(24)
        picture = Image.new("L", (700, 60 + 40 * len(lines)), 255)
        draw = ImageDraw.Draw(picture)
        for i, line in enumerate(lines):
            draw.text((40, 30 + 40 * i), line, fill=20, font=font)
        out = io.BytesIO()
        picture.convert("RGB").save(out, format=fmt)
        return out.getvalue()

    def test_a_receipt_photo_is_read_with_ocr(self) -> None:
        result = extract_document(self.image([line for line in RECEIPT.splitlines() if line], "JPEG"), "ZusReceipt.jpeg")
        self.assertEqual((result["doc_type"], result["source"]), ("claim_receipt", "ocr"))
        got = fields(result)
        self.assertEqual((got.get("receipt_ref"), got.get("date"), got.get("total")), ("ZUS-KCH-004871", "2026-10-14", 5455))
        self.assertEqual(len(result["lines"]), 3)

    def test_a_photographed_invoice_is_read_as_an_invoice(self) -> None:
        lines = ["Borneo Steel Trading Sdn Bhd", "INVOICE", "Invoice No. BST-INV-26-1019", "Invoice Date 25 Sep 2026",
                 "PO No. SFSB-PO-2026-0104", "Grand Total (RM) 9,141.00"]
        result = extract_document(self.image(lines), "photo.png")
        self.assertEqual((result["doc_type"], result["source"]), ("invoice", "ocr"))
        self.assertEqual(fields(result)["invoice_no"], "BST-INV-26-1019")
        self.assertTrue(all(f["confidence"] <= 0.8 for f in result["fields"]))  # OCR values are always shown for a check

    def test_an_image_without_text_is_refused(self) -> None:
        with self.assertRaises(ExtractionError):
            extract_document(self.image([]), "blank.png")


if __name__ == "__main__":
    unittest.main()
