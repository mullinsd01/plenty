Response bodies in the shape of the Open Food Facts v2 product API
(`GET /api/v2/product/<barcode>.json?fields=...`), used by the barcode tests so they never touch the network.
They are written to match the documented response shape (status, status_verbose, product.*) rather than captured
live, plus a few hostile or malformed ones that community-edited data could produce.
