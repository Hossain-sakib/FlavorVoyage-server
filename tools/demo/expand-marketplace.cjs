/** Operator-only demo expansion. Uses existing pack details and stored photos. */
const regions = [
  ["mirpur", "Mirpur, Dhaka", 23.8223, 90.3654],
  ["sylhet", "Sylhet", 24.8949, 91.8687],
  ["rajshahi", "Rajshahi", 24.3745, 88.6042],
  ["khulna", "Khulna", 22.8456, 89.5403],
  ["barishal", "Barishal", 22.701, 90.3535],
  ["rangpur", "Rangpur", 25.7439, 89.2752],
  ["cumilla", "Cumilla", 23.4607, 91.1809],
  ["mymensingh", "Mymensingh", 24.7471, 90.4203],
];
function expandMarketplace(db) {
  // Deterministic selection and IDs make repeat imports safe.
  const roots = db.products.filter((p) => p.active !== false && !p.catalogOnly && p.seeded);
  if (roots.length < 14) throw Error("At least 14 existing catalog products are required.");
  let added = 0;
  for (const [index, [slug, location, latitude, longitude]] of regions.entries()) {
    const supplierId = `s-cosmobit-${slug}`;
    const selection = Array.from({ length: 14 }, (_, n) => roots[(index * 7 + n * 3) % roots.length]);
    if (!db.suppliers.some((s) => s.id === supplierId)) db.suppliers.push({
      id: supplierId,
      name: `Cosmobit Beverage Shop — ${location}`,
      location, latitude, longitude,
      address: `${location} (approximate demo location)`,
      initials: "CB", color: "#e4eee6", seeded: true, demoShop: true,
      categories: [...new Set(selection.map((p) => p.category))],
      description: "Fictional demo shop for exploring local beverage stock and comparing dealer offers. Not an authorized distributor claim.",
      deliveryNote: "Sample delivery area only. Prices, availability and delivery terms are demonstration data.",
    });
    for (const [n, source] of selection.entries()) {
      const id = `${supplierId}-${source.id}`;
      if (db.products.some((p) => p.id === id)) continue;
      db.products.push({
        ...structuredClone(source), id, supplierId,
        familyId: source.familyId || source.id,
        variantKey: source.servingSize || source.pack,
        variantLabel: source.servingSize || source.pack,
        catalogOnly: true, seeded: true, demoListing: true,
        price: Math.max(5, Math.round(source.price * (0.96 + ((index + n) % 7) * 0.015) / 5) * 5),
        stock: n === 13 ? 0 : n === 12 ? 4 : 25 + ((index * 31 + n * 17) % 180),
        moq: 1 + ((index + n) % 3), badge: "Demo dealer offer",
      });
      added++;
    }
  }
  return added;
}
module.exports = { expandMarketplace };
