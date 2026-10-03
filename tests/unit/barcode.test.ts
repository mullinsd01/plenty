import { describe, expect, it } from "vitest";
import { expandUpcE, formatHintFrom, gs1CheckDigit, hasValidCheckDigit, parseBarcode } from "@/lib/barcode";

/** A real-shaped number: the body plus its correct check digit. */
const withCheck = (body: string) => `${body}${gs1CheckDigit(body)}`;

function gtin(input: unknown, hint?: Parameters<typeof parseBarcode>[1]) {
  const r = parseBarcode(input, hint);
  return r.ok ? r.barcode.gtin : `rejected:${r.reason}`;
}

describe("check digits", () => {
  it("accepts well-known real barcodes", () => {
    for (const code of ["5449000000996", "3017620422003", "4006381333931", "012345678905", "96385074", "73513537"]) {
      expect(hasValidCheckDigit(code), code).toBe(true);
    }
  });

  it("rejects any single changed digit", () => {
    const code = "5449000000996";
    for (let i = 0; i < code.length; i += 1) {
      for (const d of "0123456789") {
        if (d === code[i]) continue;
        expect(hasValidCheckDigit(code.slice(0, i) + d + code.slice(i + 1)), `${i}:${d}`).toBe(false);
      }
    }
  });
});

describe("parseBarcode: formats", () => {
  it("keeps EAN-13 as is", () => {
    expect(gtin("5449000000996")).toBe("5449000000996");
    expect(parseBarcode("5449000000996")).toMatchObject({ ok: true, barcode: { kind: "ean13", display: "5 449000 000996" } });
  });

  it("pads UPC-A to GTIN-13 so it matches the same item scanned as EAN-13", () => {
    expect(gtin("012345678905")).toBe("0012345678905");
    expect(gtin("0012345678905")).toBe("0012345678905");
    expect(gtin("036000291452")).toBe("0036000291452");
  });

  it("keeps EAN-8 at 8 digits", () => {
    expect(gtin("96385074")).toBe("96385074");
  });

  it("expands UPC-E to UPC-A, then GTIN-13 (the published example)", () => {
    expect(expandUpcE("04252614")).toBe("042100005264");
    expect(gtin("04252614", "upc_e")).toBe("0042100005264");
    expect(parseBarcode("04252614", "upc_e")).toMatchObject({ ok: true, barcode: { kind: "upce" } });
  });

  it("expands every UPC-E suppression pattern", () => {
    // [six UPC-E digits, the 11-digit UPC-A body they stand for (number system 0)]
    const rules: Array<[string, string]> = [
      ["123450", "01200000345"],
      ["123451", "01210000345"],
      ["123452", "01220000345"],
      ["123453", "01230000045"],
      ["123454", "01234000005"],
      ["123455", "01234500005"],
      ["123459", "01234500009"],
    ];
    for (const [six, body] of rules) {
      const check = gs1CheckDigit(body);
      expect(expandUpcE(`0${six}${check}`), six).toBe(`${body}${check}`);
      // Number system 1 works the same way.
      const body1 = `1${body.slice(1)}`;
      expect(expandUpcE(`1${six}${gs1CheckDigit(body1)}`), `1${six}`).toBe(`${body1}${gs1CheckDigit(body1)}`);
    }
    expect(expandUpcE("04252615")).toBeNull(); // wrong check digit
    expect(expandUpcE("24252614")).toBeNull(); // number system 2 isn't UPC-E
    expect(expandUpcE("0425261")).toBeNull();
  });

  it("decides between EAN-8 and UPC-E from the scanner's hint, never against the check digit", () => {
    const upcEOnly = "04252614"; // valid UPC-E, not a valid EAN-8
    expect(hasValidCheckDigit(upcEOnly)).toBe(false);
    expect(gtin(upcEOnly)).toBe("0042100005264"); // no hint: it can only be UPC-E
    expect(gtin(upcEOnly, "ean_8")).toBe("rejected:bad_checksum");
    expect(gtin("96385074", "ean_8")).toBe("96385074");
    expect(gtin("96385074", "upc_e")).toBe("rejected:bad_checksum");
  });

  it("turns ITF-14 with indicator 0 into the GTIN-13 and flags other indicators as packaging", () => {
    const single = withCheck("0" + "930063360334"); // 0 + GTIN-13 body
    const gtin13 = single.slice(1);
    expect(gtin(single)).toBe(gtin13);
    expect(parseBarcode(single)).toMatchObject({ ok: true, barcode: { kind: "itf14", packaging: false } });
    const carton = withCheck("1" + "930063360334");
    expect(gtin(carton)).toBe(carton);
    expect(parseBarcode(carton)).toMatchObject({ ok: true, barcode: { kind: "gtin14", packaging: true } });
  });

  it("accepts digits written in groups, and trims", () => {
    expect(gtin(" 5 449000 000996 ")).toBe("5449000000996");
    expect(gtin("5449-000-000996")).toBe("5449000000996");
    expect(gtin("5449000000996\n")).toBe("5449000000996");
  });
});

describe("parseBarcode: refusals", () => {
  it("refuses empty and non-string input", () => {
    for (const bad of ["", "   ", "\n\t", undefined, null, 5449000000996, {}, [], ["5449000000996"], true]) {
      expect(gtin(bad), String(bad)).toBe("rejected:empty");
    }
  });

  it("refuses anything that isn't plain digits", () => {
    const junk = [
      "abc",
      "5449000000996x",
      "x5449000000996",
      "5449000000996e0",
      "0x5449000000996",
      "-5449000000996",
      "+5449000000996",
      "5449000000996.0",
      "5449  000000996", // two separators in a row
      "5449--000000996",
      "5449-",
      " - ",
      "１２３４５６７８", // full-width digits
      "٩٨٧٦٥٤٣٢", // Arabic-Indic digits
      "5449000000996\u200b", // zero-width space
      "5449000000996\u0000",
      "54490000\u202e00996", // right-to-left override
      "5449000000996\r\n5449000000996",
      "5449\t000000996",
      "'; DROP TABLE product_barcodes; --",
      "../../etc/passwd",
      "<script>alert(1)</script>",
      "NaN",
      "Infinity",
      "1e13",
      "🥛🥛🥛🥛🥛🥛🥛🥛",
    ];
    for (const bad of junk) {
      const r = parseBarcode(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(r.reason, JSON.stringify(bad)).toBe("not_digits");
    }
  });

  it("refuses huge input without choking", () => {
    const started = Date.now();
    expect(gtin("1".repeat(100_000))).toBe("rejected:not_digits");
    expect(gtin("1 ".repeat(50_000))).toBe("rejected:not_digits");
    expect(gtin("9".repeat(65))).toBe("rejected:not_digits");
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("refuses wrong lengths", () => {
    for (const len of [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 15, 16, 20]) {
      expect(gtin("1".repeat(len)), String(len)).toBe("rejected:bad_length");
    }
  });

  it("refuses numbers whose check digit is wrong", () => {
    expect(gtin("5449000000997")).toBe("rejected:bad_checksum");
    expect(gtin("012345678906")).toBe("rejected:bad_checksum");
    expect(gtin("96385075")).toBe("rejected:bad_checksum");
    expect(gtin("10012345678903")).toBe("rejected:bad_checksum");
  });

  it("refuses all-zero numbers, which pass the check-digit sum", () => {
    for (const z of ["00000000", "000000000000", "0000000000000", "00000000000000"]) {
      expect(gtin(z), z).toBe("rejected:all_zero");
    }
  });

  it("refuses valid numbers that aren't products anyone can look up, with a reason", () => {
    expect(gtin(withCheck("200000000123"))).toBe("rejected:in_store"); // EAN-13 20-29: shop-printed
    expect(gtin(withCheck("21234560012"))).toBe("rejected:in_store"); // UPC-A number system 2: weighed
    expect(gtin(withCheck("40000123456"))).toBe("rejected:in_store"); // UPC-A number system 4: in-store
    expect(gtin(withCheck("990000000123"))).toBe("rejected:coupon");
    expect(gtin(withCheck("51234567890"))).toBe("rejected:coupon"); // UPC-A number system 5
    expect(gtin(withCheck("978030640615"))).toBe("rejected:publication");
    expect(gtin(withCheck("930063360334"))).toBe(withCheck("930063360334")); // an ordinary Australian number still works
    const variable = withCheck("9" + "930063360334");
    expect(gtin(variable)).toBe("rejected:in_store"); // GTIN-14 indicator 9: variable measure
  });

  it("gives every refusal a plain message", () => {
    for (const bad of ["", "abc", "123", "5449000000997", "000000000000", withCheck("200000000123"), withCheck("990000000123"), withCheck("978030640615")]) {
      const r = parseBarcode(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message.length).toBeGreaterThan(10);
        expect(r.message).not.toMatch(/undefined|error|exception|stack/i);
      }
    }
  });
});

describe("formatHintFrom", () => {
  it("maps scanner names to the BarcodeDetector vocabulary", () => {
    expect(formatHintFrom("EAN-13")).toBe("ean_13");
    expect(formatHintFrom("ean_13")).toBe("ean_13");
    expect(formatHintFrom("UPC-A")).toBe("upc_a");
    expect(formatHintFrom("UPC-E")).toBe("upc_e");
    expect(formatHintFrom("EAN-8")).toBe("ean_8");
    expect(formatHintFrom("ITF")).toBe("itf");
    expect(formatHintFrom("QRCode")).toBeUndefined();
    expect(formatHintFrom(undefined)).toBeUndefined();
    expect(formatHintFrom(42)).toBeUndefined();
  });
});
