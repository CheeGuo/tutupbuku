"""OCR for photographed receipts and documents, using a local Tesseract install (nothing leaves the machine).

Tesseract is found from TESSERACT_CMD, then PATH, then the default Windows install folders. Images are cleaned up
with Pillow (grayscale, enlarged when small, contrast stretched) before OCR. The text is then parsed into the
frontend's receipt fields; values that are only a best guess carry a low confidence so the UI asks for a check.
"""

from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_PIXELS = 40_000_000
OCR_TIMEOUT_SECONDS = 60
IMAGE_SIGNATURES = (b"\xff\xd8\xff", b"\x89PNG\r\n\x1a\n", b"RIFF", b"GIF8", b"BM", b"II*\x00", b"MM\x00*")
AMOUNT = r"\d{1,3}(?:[,\s]\d{3})*[.,]\d{2}|\d+[.,]\d{2}"
NOT_ITEMS = re.compile(r"sub\s*-?\s*total|total|tax|sst|gst|service|round|cash|change|tender|card|visa|master|paid|balance|amount\s+due|discount|voucher|tips?\b|\bqty\b|\bprice\b", re.I)


class OcrError(ValueError):
    """The image could not be read."""


def tesseract_path() -> str | None:
    configured = os.environ.get("TESSERACT_CMD")
    if configured and Path(configured).is_file():
        return configured
    found = shutil.which("tesseract")
    if found:
        return found
    for candidate in (Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Tesseract-OCR" / "tesseract.exe",
                      Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Tesseract-OCR" / "tesseract.exe"):
        if candidate.is_file():
            return str(candidate)
    return None


def available() -> bool:
    return tesseract_path() is not None


def _prepare(content: bytes, enhanced: bool = False) -> bytes:
    """Validate the image and return a cleaned-up PNG for OCR.

    enhanced: enlarge to 2600 px, sharpen and threshold to black and white. This reads small, light-grey print
    (item options on app receipts) far better, but can black out a dim photo, so the plain version is the fallback."""
    try:
        from PIL import Image, ImageFilter, ImageOps
    except ImportError as exc:  # pragma: no cover - environment problem, reported to the user
        raise OcrError("The image library is not installed on the server (py -3.13 -m pip install Pillow).") from exc
    try:
        with Image.open(io.BytesIO(content)) as image:
            if image.width * image.height > MAX_PIXELS:
                raise OcrError("The image is too large to read.")
            image = ImageOps.exif_transpose(image).convert("L")   # phone photos carry their rotation in EXIF
            target = 2600 if enhanced else 1400
            if image.width < target:
                image = image.resize((target, int(image.height * target / image.width)), Image.Resampling.LANCZOS)
            image = ImageOps.autocontrast(image, cutoff=1)
            if enhanced:
                image = image.filter(ImageFilter.UnsharpMask(radius=2, percent=150, threshold=2)).point(lambda v: 255 if v > 200 else 0)
            out = io.BytesIO()
            image.save(out, format="PNG")
            return out.getvalue()
    except OcrError:
        raise
    except Exception as exc:  # noqa: BLE001 - Pillow raises many types for damaged files
        raise OcrError("The image could not be opened.") from exc


def image_text(content: bytes, psm: int = 6, enhanced: bool = False) -> str:
    """OCR one image. psm 6 reads a uniform block row by row (keeps a receipt's item and price together);
    psm 4 reads a single column of variable-size text."""
    if len(content) > MAX_IMAGE_BYTES:
        raise OcrError(f"The image is larger than {MAX_IMAGE_BYTES // (1024 * 1024)} MB.")
    if not content.startswith(IMAGE_SIGNATURES):
        raise OcrError("The file is not a supported image (JPG, PNG, WEBP, GIF, BMP or TIFF).")
    command = tesseract_path()
    if command is None:
        raise OcrError("OCR is not installed on the server. Install Tesseract (winget install --id UB-Mannheim.TesseractOCR -e) or set TESSERACT_CMD.")
    png = _prepare(content, enhanced)
    with tempfile.TemporaryDirectory(prefix="tutupbuku-ocr-") as folder:
        source = Path(folder) / "page.png"
        source.write_bytes(png)
        try:
            result = subprocess.run([command, str(source), "stdout", "-l", "eng", "--psm", str(psm)], capture_output=True,
                                    timeout=OCR_TIMEOUT_SECONDS, check=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except subprocess.TimeoutExpired as exc:
            raise OcrError("OCR took too long on this image.") from exc
    if result.returncode != 0:
        raise OcrError("OCR failed on this image.")
    return result.stdout.decode("utf-8", "replace")


# ---------------------------------------------------------------- receipt parsing

def _sen(text: str) -> int:
    cleaned = re.sub(r"[\s,](?=\d{3}\b)", "", text.strip())
    cleaned = cleaned.replace(",", ".")
    whole, _, cents = cleaned.rpartition(".")
    return int(whole or "0") * 100 + int(cents[:2].ljust(2, "0"))


def _amounts(line: str) -> list[str]:
    return re.findall(rf"(?<![\d.,])(?:RM\s*)?({AMOUNT})(?![\d.,])", line, flags=re.I)


MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}


def _date(text: str) -> str | None:
    patterns = [
        (r"\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b", lambda m: (int(m[1]), int(m[2]), int(m[3]))),
        (r"\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b", lambda m: (int(m[3]), int(m[2]), int(m[1]))),     # dd/mm/yyyy (Malaysia)
        (r"\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})\b", lambda m: (2000 + int(m[3]), int(m[2]), int(m[1]))),
        (r"\b(\d{1,2})[ -]([A-Za-z]{3})[A-Za-z]*[ -,]*(\d{4})\b", lambda m: (int(m[3]), MONTHS.get(m[2].lower(), 0), int(m[1]))),
        (r"\b([A-Za-z]{3})[A-Za-z]* (\d{1,2}),? (\d{4})\b", lambda m: (int(m[3]), MONTHS.get(m[1].lower(), 0), int(m[2]))),
    ]
    for pattern, parts in patterns:
        for match in re.finditer(pattern, text):
            try:
                year, month, day = parts(match)
                if not 2000 <= year <= datetime.now().year + 1:   # e.g. "2826" is an OCR misread, not a date
                    continue
                return datetime(year, month, day).strftime("%Y-%m-%d")
            except ValueError:
                continue
    return None


def _field(key: str, label: str, value: str, kind: str = "text", confidence: float = 0.8) -> dict[str, Any]:
    return {"key": key, "label": label, "kind": kind, "value": value, "confidence": confidence}


def _money(key: str, label: str, sen: int, confidence: float = 0.8) -> dict[str, Any]:
    return {"key": key, "label": label, "kind": "money", "value": "", "sen": sen, "confidence": confidence}


def best_text(content: bytes) -> str:
    """OCR with the enhanced image first, then plainer settings, and keep the text that yields the most complete receipt."""
    def score(text: str) -> int:
        parsed = parse_receipt(text)
        return len(parsed["fields"]) * 2 + len(parsed["lines"]) - len(parsed["warnings"])
    tried: list[str] = []
    for psm, enhanced in ((6, True), (6, False), (4, False)):
        text = image_text(content, psm, enhanced)
        if not parse_receipt(text)["warnings"]:
            return text
        tried.append(text)
    return max(tried, key=score)


def parse_receipt(text: str) -> dict[str, Any]:
    """Merchant, date, reference, total, tax and item lines from receipt text. Best guesses are marked low-confidence."""
    # OCR often puts spaces around separators ("ZUS - KCH-004871", "14/10/ 2026"); close them up first.
    text = re.sub(r"(?<=[A-Za-z0-9])[ \t]*([/-])[ \t]*(?=[A-Za-z0-9])", r"\1", text)
    lines = [" ".join(line.split()) for line in text.splitlines() if line.strip()]
    warnings: list[str] = []
    fields: list[dict[str, Any]] = []

    reference = None
    for line in lines:
        match = re.search(r"(?:receipt|invoice|bill|order|check|cheque|rcpt|inv|trans(?:action)?|doc)\s*(?:no\.?|number|#|id)?\s*[:#.]?\s*([A-Z0-9][A-Z0-9/-]{3,})", line, re.I)
        if match and re.search(r"\d", match.group(1)):
            reference = match.group(1)
            break
    if reference:
        fields.append(_field("receipt_ref", "Receipt reference", reference))
    else:
        warnings.append("Receipt number not found.")

    date = _date(" ".join(lines))
    if date:
        fields.append(_field("date", "Date", date, "date"))
    else:
        warnings.append("Receipt date not found.")

    # The registered company name is the most reliable merchant; logos at the top often OCR as noise.
    company = next((line for line in lines[:12] if re.search(r"\b(sdn\.?\s*bhd|berhad|bhd|plt|enterprise|trading|ltd)\b", line, re.I)), None)
    if company:
        merchant, confidence = re.sub(r"\s*\((?=[^)]*\d)[^)]*\)\s*", " ", company).strip(" -*:,"), 0.85   # drop "(1340330-X)"
    else:
        merchant = next((line for line in lines[:6] if len(re.findall(r"[A-Za-z]", line)) >= 3
                         and len(re.findall(r"[A-Za-z ]", line)) >= 0.8 * len(line)
                         and not re.search(r"receipt|invoice|tax|tel|phone|fax|www|http|@|\bno\b|address|gst|sst|reg", line, re.I)), None)
        confidence = 0.6
    if merchant:
        fields.append(_field("merchant", "Merchant", merchant.strip(" -*:"), confidence=confidence))
    else:
        warnings.append("Merchant name not found.")

    total = None
    for pattern in (r"grand\s*total|total\s*(?:amount|due|payable)|amount\s*(?:due|payable)|nett?\s*total", r"(?<!sub)(?<!sub )total"):
        for line in reversed(lines):
            if re.search(pattern, line, re.I) and not re.search(r"sub\s*-?\s*total|total\s*(?:qty|items?)", line, re.I):
                found = _amounts(line)
                if found:
                    total = _sen(found[-1])
                    break
        if total is not None:
            break
    tax = None
    for line in lines:
        if re.search(r"\b(sst|gst|service\s*(?:tax|charge)|tax)\b", line, re.I) and not re.search(r"incl|tax\s*invoice|reg", line, re.I):
            found = _amounts(line)
            if found:
                tax = _sen(found[-1])
                break

    items: list[dict[str, Any]] = []
    total_index = next((i for i, line in reversed(list(enumerate(lines))) if total is not None and re.search(r"total", line, re.I)), len(lines))
    pending: str | None = None   # a product name printed on the line above its options, quantity and price
    for line in lines[:total_index]:
        found = _amounts(line)
        if not found or NOT_ITEMS.search(line) or _date(line):
            words = len(re.findall(r"[A-Za-z]{2,}", line))
            pending = line if words and not found and not re.search(r"^(item|description|order|qty|quantity|customer|cashier|table|payment|date)\b|:\s*$", line, re.I) else None
            continue
        amount = _sen(found[-1])
        if amount == 0:   # vouchers, free add-ons and zero fees are not purchases
            pending = None
            continue
        description = re.sub(rf"(?:RM\s*)?(?:{AMOUNT})", " ", line, flags=re.I)
        quantity = 1
        qty = (re.match(r"\s*(\d{1,3})\s*[xX@*]\s*", description) or re.search(r"\s[xX]\s*(\d{1,3})\s*$", description)
               or re.search(r"(?<=[^\W\d_]|[.,)'*])\s+(\d{1,2})\s*$", description))   # "Iced Latte 1 RM 12.90": quantity column
        if qty:
            quantity = int(qty.group(1)) or 1
            description = description[: qty.start()] + " " + description[qty.end():]
        description = " ".join(description.split()).strip(" -*:.")
        # Options under a product ("Dairy, Regular Sweet" or a one-word size) belong to the product name above them.
        if pending and (len(description.split()) <= 2 or "," in description):
            description = f"{pending.strip(' -*:.')} ({description})" if description else pending.strip(" -*:.")
        pending = None
        if len(re.findall(r"[A-Za-z]", description)) < 2:
            continue
        unit = round(amount / quantity) if quantity else amount
        items.append({"id": f"l{len(items) + 1}", "description": description[:120], "quantity": quantity, "unitSen": unit, "totalSen": amount})

    if total is None and items:
        total = sum(i["totalSen"] for i in items)
        warnings.append("No total line was found; the total is the sum of the items. Check it against the receipt.")
        fields.append(_money("total", "Total", total, 0.5))
    elif total is not None:
        item_sum = sum(i["totalSen"] for i in items)
        consistent = bool(items) and abs(item_sum + (tax or 0) - total) <= 5 or abs(item_sum - total) <= 5
        fields.append(_money("total", "Total", total, 0.85 if consistent else 0.6))
        if items and not consistent:
            warnings.append("The items read from the photo do not add up to the total; check the lines against the receipt.")
    else:
        warnings.append("Total amount not found.")
    if tax is not None:
        fields.append(_money("tax", "Tax", tax, 0.7))
    if not items:
        warnings.append("No item lines could be read.")
    return {"doc_type": "claim_receipt", "fields": fields, "lines": items[:30], "warnings": warnings}
