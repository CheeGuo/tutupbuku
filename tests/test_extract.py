"""Reading uploaded purchasing PDFs: classification, fields, line items, and the /api/extract route.

Uses the sample PDFs shipped with the frontend (frontend/public/sample-docs), which are the test-data chains."""

from __future__ import annotations

import base64
import importlib.util
import json
import shutil
import tempfile
import unittest
from http.client import HTTPConnection
from pathlib import Path
from threading import Thread

from tutupbuku.extract import ExtractionError, extract_document
from tutupbuku.service import TutupBukuService
from tutupbuku.web import create_server

DOCS = Path(__file__).resolve().parents[1] / "frontend" / "public" / "sample-docs"
FIXTURE = Path(__file__).resolve().parents[1] / "demo-fixtures" / "Sept2026"
HAVE_PYPDF = importlib.util.find_spec("pypdf") is not None


def read(relative: str) -> dict:
    return extract_document((DOCS / relative).read_bytes(), Path(relative).name)


def fields(doc: dict) -> dict:
    return {f["key"]: f.get("sen", f["value"]) for f in doc["fields"]}


@unittest.skipUnless(HAVE_PYPDF and DOCS.is_dir(), "pypdf or the sample PDFs are not available")
class ExtractTests(unittest.TestCase):
    def test_price_variance_invoice_is_read_from_the_pdf(self) -> None:
        doc = read("Chain4_BST_SFSB-PO-2026-0104_PriceVariance/04_Invoice_BST-INV-26-1019.pdf")
        self.assertEqual(doc["doc_type"], "invoice")
        self.assertEqual(fields(doc), {"invoice_no": "BST-INV-26-1019", "date": "2026-09-25", "supplier": "Borneo Steel Trading Sdn Bhd",
                                       "po_ref": "SFSB-PO-2026-0104", "do_ref": "BST-DO-26-0611", "due_date": "2026-10-25",
                                       "payment_terms": "30 Days", "tax": 83100, "grand_total": 914100})
        self.assertEqual([(l["quantity"], l["unitSen"], l["totalSen"]) for l in doc["lines"]], [(30, 12000, 360000), (50, 4500, 225000), (6, 41000, 246000)])
        self.assertEqual(doc["warnings"], [])

    def test_wrapped_layout_split_invoice_two_delivery_orders_and_instalments(self) -> None:
        doc = read("Chain6_KOS_SFSB-PO-2026-0097_SplitPayment/04_Invoice_KOS-INV-26-0397.pdf")
        got = fields(doc)
        self.assertEqual(got["do_ref"], "KOS/DO/26/0395, KOS/DO/26/0411")
        self.assertEqual(got["due_date"], "2026-10-18")
        self.assertEqual(got["payment_terms"], "50% within 14 days, balance within 30 days")
        self.assertEqual(got["supplier"], "Kenyalang Office Supplies Sdn Bhd")
        self.assertEqual(doc["lines"][0]["description"], "Office Workstation 1200mm L-shape with mobile pedestal")

    def test_delivery_orders_take_the_quantity_delivered_this_time(self) -> None:
        partial = read("Chain6_KOS_SFSB-PO-2026-0097_SplitPayment/03a_DeliveryOrder_KOS-DO-26-0395.pdf")
        self.assertEqual([l["quantity"] for l in partial["lines"]], [8, 4, 0])
        full = read("Chain1_BST_SFSB-PO-2026-0087/03_DeliveryOrder_BST-DO-26-0517.pdf")
        self.assertEqual([l["quantity"] for l in full["lines"]], [20, 10, 40])
        self.assertEqual(fields(full)["po_ref"], "SFSB-PO-2026-0087")

    def test_payment_advice_and_receipt(self) -> None:
        advice = fields(read("Chain6_KOS_SFSB-PO-2026-0097_SplitPayment/05a_PaymentAdvice_SFSB-PA-2026-0069.pdf"))
        self.assertEqual((advice["advice_no"], advice["invoice_ref"], advice["amount"], advice["instalment"], advice["supplier"]),
                         ("SFSB-PA-2026-0069", "KOS/INV/26/0397", 811800, "1st instalment (50%)", "Kenyalang Office Supplies Sdn Bhd"))
        receipt = fields(read("Chain1_BST_SFSB-PO-2026-0087/06_Receipt_BST-OR-26-0334.pdf"))
        self.assertEqual((receipt["receipt_no"], receipt["amount"], receipt["payment_reference"]), ("BST-OR-26-0334", 2396900, "IBG2609100458"))

    def test_the_document_type_comes_from_the_content_not_the_file_name(self) -> None:
        content = (DOCS / "Chain3_KOS_SFSB-PO-2026-0101/02_PurchaseOrder_SFSB-PO-2026-0101.pdf").read_bytes()
        doc = extract_document(content, "Doc001.pdf")
        self.assertEqual((doc["doc_type"], fields(doc)["po_no"], fields(doc)["quotation_ref"]), ("purchase_order", "SFSB-PO-2026-0101", "KOS/Q/26/0219"))

    def test_unreadable_input_is_refused_not_guessed(self) -> None:
        for content in (b"not a pdf", b"%PDF-1.4 broken"):
            with self.subTest(content=content[:10]), self.assertRaises(ExtractionError):
                extract_document(content)

    def test_extract_route(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            shutil.copytree(FIXTURE, Path(temp) / "fixtures" / "Sept2026")
            server = create_server(TutupBukuService(Path(temp)), "127.0.0.1", 0)
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                connection = HTTPConnection("127.0.0.1", server.server_port, timeout=20)

                def post(payload: dict) -> tuple[int, dict]:
                    connection.request("POST", "/api/extract", body=json.dumps(payload), headers={"Content-Type": "application/json"})
                    response = connection.getresponse()
                    return response.status, json.loads(response.read())

                pdf = (DOCS / "Chain2_BST_SFSB-PO-2026-0094/04_Invoice_BST-INV-26-0947.pdf").read_bytes()
                status, body = post({"filename": "upload.pdf", "content_base64": base64.b64encode(pdf).decode()})
                self.assertEqual((status, body["doc_type"]), (200, "invoice"))
                self.assertEqual(post({"filename": "notes.txt", "content_base64": base64.b64encode(b"x").decode()})[0], 415)
                self.assertEqual(post({"filename": "photo.jpg", "content_base64": base64.b64encode(b"not an image").decode()})[0], 422)
                self.assertEqual(post({"filename": "x.pdf", "content_base64": base64.b64encode(b"nope").decode()})[0], 422)
                self.assertEqual(post({"filename": "x.pdf", "content_base64": "%%%"})[0], 400)
                self.assertEqual(post({"filename": "x.pdf", "content_base64": "", "extra": 1})[0], 400)
                connection.close()
            finally:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
