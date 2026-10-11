"""Read an uploaded purchasing PDF: classify it and extract its fields and line items.

Works on PDFs that carry a text layer (generated or "searchable" PDFs). Scanned images have no text layer and
need real OCR, which is not connected; they are reported as unreadable instead of guessed.

The output uses the frontend's record shape (frontend/src/types.ts: Field, LineItem) and the same field keys as the
transcribed test records, so the purchasing checks treat a read document exactly like a saved one.
"""

from __future__ import annotations

import io
import logging
import re
from datetime import datetime
from typing import Any

MAX_PDF_BYTES = 10 * 1024 * 1024
BUYER = "sarawak fabrication"

# The heading printed on each document type, matched as a whole line.
TITLES = [
    ("payment_advice", "PAYMENT ADVICE"), ("payment_receipt", "OFFICIAL RECEIPT"), ("delivery_order", "DELIVERY ORDER"),
    ("purchase_order", "PURCHASE ORDER"), ("quotation", "QUOTATION"), ("invoice", "INVOICE"), ("invoice", "TAX INVOICE"),
]
# Document numbers look like BST-INV-26-1019, KOS/INV/26/0397, SFSB-PO-2026-0097: prefix, type code, year, serial.
NUMBER = re.compile(r"\b([A-Z]{2,5})([-/])([A-Z]{1,3})\2(\d{2,4})\2(\d{3,5}[A-Z]?)\b")
CODES = {"quotation": {"QT", "Q"}, "purchase_order": {"PO"}, "delivery_order": {"DO"}, "invoice": {"INV"},
         "payment_advice": {"PA"}, "payment_receipt": {"OR", "R"}}
OWN_KEY = {"quotation": ("quotation_no", "Quotation number"), "purchase_order": ("po_no", "PO number"),
           "delivery_order": ("do_no", "DO number"), "invoice": ("invoice_no", "Invoice number"),
           "payment_advice": ("advice_no", "Payment advice number"), "payment_receipt": ("receipt_no", "Receipt number")}
DATE = re.compile(r"\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* (\d{4})\b")
AMOUNT = re.compile(r"\b\d{1,3}(?:,\d{3})*\.\d{2}\b")
# Field labels; a label's value runs until the next label (values can wrap over several lines).
LABELS = ["Quotation No.", "PO No.", "Your PO No.", "DO No.", "Invoice No.", "Advice No.", "Receipt No.", "Your Advice No.",
          "Invoice Date", "PO Date", "Advice Date", "Payment Date", "Date", "Valid Until", "Required Date", "Due Date",
          "Payment Terms", "Payment Mode", "Payment Ref.", "Paying Bank", "Delivery", "Sales Person", "Currency",
          "Quotation Ref.", "Our Quotation", "Vehicle No.", "No.", "Dear Sir/Madam,", "Received with thanks"]


class ExtractionError(ValueError):
    """The file could not be read as a purchasing document."""


def pdf_text(content: bytes) -> str:
    if len(content) > MAX_PDF_BYTES:
        raise ExtractionError(f"The PDF is larger than {MAX_PDF_BYTES // (1024 * 1024)} MB.")
    try:
        from pypdf import PdfReader
        from pypdf.errors import PyPdfError
    except ImportError as exc:  # pragma: no cover - environment problem, reported to the user
        raise ExtractionError("The PDF reader is not installed on the server (py -3.13 -m pip install pypdf).") from exc
    logging.getLogger("pypdf").setLevel(logging.ERROR)  # a damaged PDF is reported to the user, not logged to the console
    try:
        reader = PdfReader(io.BytesIO(content))
        if len(reader.pages) > 20:
            raise ExtractionError("The PDF has more than 20 pages.")
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    except PyPdfError as exc:
        raise ExtractionError("The PDF could not be opened.") from exc


def _iso(match: re.Match[str]) -> str:
    return datetime.strptime(f"{match.group(1)} {match.group(2)} {match.group(3)}", "%d %b %Y").strftime("%Y-%m-%d")


def _sen(text: str) -> int:
    whole, cents = text.replace(",", "").split(".")
    return int(whole) * 100 + int(cents)


class _Text:
    def __init__(self, text: str) -> None:
        self.lines = [" ".join(line.split()) for line in text.splitlines() if line.strip()]
        self.flat = " ".join(self.lines)

    def after(self, label: str) -> str | None:
        """The text that follows a label line (or a label at the start of a line), up to the next label."""
        for index, line in enumerate(self.lines):
            if line == label or line.startswith(label + " "):
                parts = [line[len(label):].strip()] if line != label else []
                for nxt in self.lines[index + 1:]:
                    if parts and (nxt in LABELS or any(nxt.startswith(other + " ") for other in LABELS if len(other) > 3)):
                        break
                    if not parts and nxt in LABELS:
                        break
                    parts.append(nxt)
                    if len(parts) >= 3:
                        break
                value = " ".join(p for p in parts if p).strip()
                return value or None
        return None

    def amount_after(self, label: str) -> int | None:
        index = self.flat.find(label)
        if index < 0:
            return None
        match = AMOUNT.search(self.flat, index + len(label))
        return _sen(match.group(0)) if match else None


def _field(key: str, label: str, value: str, kind: str = "text", confidence: float = 0.99) -> dict[str, Any]:
    return {"key": key, "label": label, "kind": kind, "value": value, "confidence": confidence}


def _money(key: str, label: str, sen: int, confidence: float = 0.99) -> dict[str, Any]:
    return {"key": key, "label": label, "kind": "money", "value": "", "sen": sen, "confidence": confidence}


def _numbers(text: str, doc_type: str) -> list[str]:
    seen: list[str] = []
    for match in NUMBER.finditer(text):
        if match.group(3) in CODES[doc_type] and match.group(0) not in seen:
            seen.append(match.group(0))
    return seen


def _party(doc: _Text, doc_type: str) -> str | None:
    """The supplier: the issuing company on supplier documents, the vendor/payee on the buyer's own PO and advice."""
    if doc_type in {"purchase_order", "payment_advice"}:
        for label in ("VENDOR", "PAYEE", "SUPPLIER"):
            value = doc.after(label)
            if value:
                name = re.split(r"(?<=Bhd)\b", value, maxsplit=1)[0]
                return name.strip()
    names = [line.strip("() ") for line in doc.lines if re.search(r"\bsdn\.? bhd\b", line, re.I) and BUYER not in line.lower()]
    if not names:
        return None
    first = re.split(r"(?<=bhd)\b", names[0], maxsplit=1, flags=re.I)[0].strip()
    for line in doc.lines:  # prefer the mixed-case spelling printed elsewhere on the document
        if line.lower().startswith(first.lower()) and line != line.upper():
            return line[: len(first)]
    return " ".join(word if word.lower() not in {"sdn", "bhd"} else word.capitalize() for word in first.title().split())


def _lines(doc: _Text, doc_type: str) -> list[dict[str, Any]]:
    flat = doc.flat
    if doc_type == "delivery_order":
        # Partial deliveries print Ordered / Prev. delivered / This delivery / Balance; full ones only Ordered / Delivered.
        layouts = [("Balance UOM", r"(\d+) (\d+) (\d+) (\d+)", 3), ("Qty Delivered UOM", r"(\d+) (\d+)", 2)]
        for header, columns, delivered in layouts:
            start = flat.find(header)
            if start < 0:
                continue
            ends = [i for i in (flat.find(stop, start) for stop in ("Delivery Status", "GOODS RECEIVED")) if i > 0]
            region = flat[start + len(header): min(ends) if ends else None]
            pattern = re.compile(r"(?:^|\s)(\d{1,2}) (.+?) " + columns + r" ([A-Za-z]+)(?=\s|$)")
            return [{"id": f"l{n}", "description": m.group(2), "quantity": int(m.group(2 + delivered)), "unitSen": None, "totalSen": None}
                    for n, m in enumerate(pattern.finditer(region), start=1)]
        return []
    if doc_type not in {"quotation", "purchase_order", "invoice"}:
        return []
    start = flat.find("Amount (RM)")
    end = flat.find("Ringgit Malaysia", start)
    if end < 0:
        end = flat.find("Subtotal", start)
    region = flat[start + len("Amount (RM)"): end if end > 0 else None] if start >= 0 else ""
    pattern = re.compile(r"(?:^|\s)(\d{1,2}) (.+?) (\d+(?:\.\d+)?) ([A-Za-z]+) (" + AMOUNT.pattern + r") (" + AMOUNT.pattern + r")")
    rows = []
    for n, m in enumerate(pattern.finditer(region), start=1):
        quantity = float(m.group(3))
        rows.append({"id": f"l{n}", "description": m.group(2), "quantity": int(quantity) if quantity.is_integer() else quantity,
                     "unitSen": _sen(m.group(5)), "totalSen": _sen(m.group(6))})
    return rows


def classify(text: str) -> str | None:
    lines = {" ".join(line.split()).upper() for line in text.splitlines()[:40]}
    for doc_type, title in TITLES:
        if title in lines:
            return doc_type
    return None


def extract_document(content: bytes, filename: str = "") -> dict[str, Any]:
    """Read an uploaded PDF (its text layer) or image (OCR) and return {doc_type, fields, lines, warnings, source, ...}.

    Purchasing documents are recognised by their printed heading; an image without one is read as an expense receipt."""
    if content.startswith(b"%PDF"):
        text, source = pdf_text(content), "pdf_text"
        if len(text.strip()) < 40:
            raise ExtractionError("The PDF has no readable text layer (it looks like a scan). Save the page as a photo (JPG or PNG) and upload that instead, so it can be read with OCR.")
    else:
        from .ocr import OcrError, best_text, parse_receipt
        try:
            text, source = best_text(content), "ocr"
        except OcrError as exc:
            raise ExtractionError(str(exc)) from exc
        if len(text.strip()) < 15:
            raise ExtractionError("OCR found almost no text in this image. Try a sharper, well-lit photo taken straight on.")
    doc_type = classify(text)
    if doc_type is None:
        if source == "ocr":
            return {**parse_receipt(text), "source": source, "text_chars": len(text), "filename": filename, "text_preview": text[:1500]}
        raise ExtractionError("The document type could not be recognised (no quotation, PO, DO, invoice, payment advice or receipt heading).")
    result = _purchasing(text, doc_type, filename)
    if source == "ocr":  # OCR can misread characters: every value is shown for a check, not trusted like a PDF's text
        for item in result["fields"]:
            item["confidence"] = min(item["confidence"], 0.8)
        result["text_preview"] = text[:1500]
    return {**result, "source": source}


def _purchasing(text: str, doc_type: str, filename: str) -> dict[str, Any]:
    doc = _Text(text)
    warnings: list[str] = []
    fields: list[dict[str, Any]] = []

    own = _numbers(doc.flat, doc_type)
    key, label = OWN_KEY[doc_type]
    if own:
        fields.append(_field(key, label, own[0]))
    else:
        warnings.append(f"{label} not found.")

    date_label = {"invoice": "Invoice Date", "purchase_order": "PO Date", "payment_advice": "Advice Date"}.get(doc_type, "Date")
    date_text = doc.after(date_label) or doc.after("Date")
    date = DATE.search(date_text or "")
    if date:
        fields.append(_field("date", "Date", _iso(date), "date"))
    else:
        warnings.append("Document date not found.")

    party = _party(doc, doc_type)
    if party:
        fields.append(_field("supplier", "Supplier", party))
    else:
        warnings.append("Supplier not found.")

    def ref(key: str, label: str, of_type: str, joiner: str = ", ") -> None:
        found = _numbers(doc.flat, of_type)
        if found:
            fields.append(_field(key, label, joiner.join(found)))

    if doc_type == "quotation":
        valid = DATE.search(doc.after("Valid Until") or "")
        if valid:
            fields.append(_field("valid_until", "Valid until", _iso(valid), "date"))
    if doc_type == "purchase_order":
        ref("quotation_ref", "Quotation ref.", "quotation")
        required = DATE.search(doc.after("Required Date") or "")
        if required:
            fields.append(_field("required_date", "Required date", _iso(required), "date"))
    if doc_type in {"delivery_order", "invoice", "payment_advice", "payment_receipt"}:
        if doc_type in {"payment_advice", "payment_receipt"}:
            ref("invoice_ref", "Invoice number", "invoice")
        ref("po_ref", "PO number", "purchase_order")
    if doc_type == "delivery_order":
        status = re.search(r"Delivery Status: (.+?)(?= GOODS RECEIVED| Issued by|$)", doc.flat)
        if status:
            fields.append(_field("delivery_status", "Delivery status", status.group(1).strip()))
    if doc_type == "invoice":
        dos = _numbers(doc.flat, "delivery_order")
        if dos:
            fields.append(_field("do_ref", "Delivery orders" if len(dos) > 1 else "Delivery order", ", ".join(dos)))
        due_text = doc.after("Due Date") or ""
        due = list(DATE.finditer(due_text))
        if due:
            fields.append(_field("due_date", "Due date", _iso(due[-1]), "date"))
        if len(due) > 1:
            fields.append(_field("instalments", "Instalments", due_text))
    if doc_type in {"quotation", "purchase_order", "invoice"}:
        terms = doc.after("Payment Terms")
        if terms:
            fields.append(_field("payment_terms", "Payment term", terms))
    if doc_type in {"payment_advice", "payment_receipt"}:
        instalment = re.search(r"(\d(?:st|nd|rd|th)(?: and final)? instalment \(\d+%\))", doc.flat)
        if instalment:
            fields.append(_field("instalment", "Instalment", instalment.group(1)))
        paid = doc.amount_after("Total Amount Paid (RM)") or doc.amount_after("Total Received (RM)")
        if paid is not None:
            fields.append(_money("amount", "Amount", paid))
        else:
            warnings.append("Amount paid not found.")
        reference = doc.after("Payment Ref.")
        if reference:
            fields.append(_field("payment_reference", "Payment reference", reference.split()[0]))

    lines = _lines(doc, doc_type)
    if doc_type in {"quotation", "purchase_order", "invoice"}:
        tax = doc.amount_after("Sales Tax")
        total = doc.amount_after("Grand Total (RM)")
        subtotal = doc.amount_after("Subtotal (RM)")
        if tax is not None:
            fields.append(_money("tax", "Sales tax (10%)", tax))
        if total is not None:
            fields.append(_money("grand_total", "Grand total", total))
        else:
            warnings.append("Grand total not found.")
        if not lines:
            warnings.append("No line items could be read.")
        elif subtotal is not None and sum(line["totalSen"] for line in lines) != subtotal:
            warnings.append("The line items do not add up to the printed subtotal; check the lines against the PDF.")
            for item in fields:
                if item["kind"] == "money":
                    item["confidence"] = 0.6
    if doc_type == "delivery_order" and not lines:
        warnings.append("No delivered items could be read.")

    return {"doc_type": doc_type, "fields": fields, "lines": lines, "warnings": warnings, "text_chars": len(text), "filename": filename}
