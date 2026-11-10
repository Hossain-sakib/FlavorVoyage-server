const products = require("./catalog.json");
const categories = [
  "Soft drinks",
  "Fruit drinks",
  "Energy drinks",
  "Water",
  "Dairy & lassi",
  "Tea & coffee",
  "Malt drinks",
  "Drink mixes",
  "Traditional sips",
];
const suppliers = [
  {
    id: "s-bd-dhaka",
    name: "Dhaka Drinks Hub",
    location: "Dhaka",
    initials: "DH",
    color: "#f8e5d6",
    description:
      "Sample beverage supplier listing for exploring soft drink and energy drink orders. Not an authorized brand-distributor claim.",
    categories: ["Soft drinks", "Energy drinks"],
    seeded: true,
  },
  {
    id: "s-bd-fruit",
    name: "Fresh Sip Distribution",
    location: "Gazipur",
    initials: "FS",
    color: "#f5eacb",
    description:
      "Sample supplier selection of fruit drinks and mixes popular across Bangladesh. Confirm real terms with a supplier before commercial use.",
    categories: ["Fruit drinks", "Drink mixes"],
    seeded: true,
  },
  {
    id: "s-bd-daily",
    name: "Everyday Beverage Co.",
    location: "Narayanganj",
    initials: "EB",
    color: "#ebe3ed",
    description:
      "Sample beverage supplier listing for water, dairy, tea, coffee and malt drinks. Used for demonstration orders.",
    categories: [
      "Water",
      "Dairy & lassi",
      "Tea & coffee",
      "Malt drinks",
      "Traditional sips",
    ],
    seeded: true,
  },
];
const demoShops = [
  {
    id: "s-cosmobit-dhaka",
    name: "Cosmobit Drinks — Dhanmondi",
    location: "Dhanmondi, Dhaka",
    latitude: 23.7461,
    longitude: 90.3742,
    address: "Dhanmondi, Dhaka (demo location)",
    initials: "CD",
    color: "#f8e5d6",
  },
  {
    id: "s-cosmobit-uttara",
    name: "Cosmobit Beverage Hub — Uttara",
    location: "Uttara, Dhaka",
    latitude: 23.8759,
    longitude: 90.3795,
    address: "Uttara, Dhaka (demo location)",
    initials: "CU",
    color: "#e4eee6",
  },
  {
    id: "s-cosmobit-chattogram",
    name: "Cosmobit Drinks — Chattogram",
    location: "Chattogram",
    latitude: 22.3569,
    longitude: 91.7832,
    address: "Chattogram (demo location)",
    initials: "CC",
    color: "#ece4f1",
  },
].map((s) => ({
  ...s,
  demoShop: true,
  seeded: true,
  categories: ["Soft drinks", "Fruit drinks", "Water"],
  description:
    "Demo Cosmobit shop for trying local stock, ordering and dealer messaging. Not a real distributor or delivery promise.",
}));
const shopProducts = demoShops.flatMap((s, index) => {
  const listings = products
    .filter((p) =>
      ["bd-mojo", "bd-clemon", "bd-frooto", "bd-mum"].includes(p.id),
    )
    .map((p) => ({
      ...structuredClone(p),
      id: `${s.id}-${p.id}`,
      familyId: p.id,
      variantKey: p.servingSize || p.pack,
      variantLabel: p.servingSize || p.pack,
      supplierId: s.id,
      catalogOnly: true,
      demoListing: true,
      price: p.price + index * 12,
      moq: 2,
      stock: 80 + index * 20,
      badge: "Demo shop",
    }));
  const mojo = products.find((p) => p.id === "bd-mojo");
  listings.push({
    ...structuredClone(mojo),
    id: `${s.id}-mojo-500`,
    name: "Mojo Cola",
    familyId: mojo.id,
    image: "/images/drinks/mojo-500-photo.jpg",
    variantKey: "500 ml",
    variantLabel: "500 ml",
    servingSize: "500 ml",
    pack: "12 × 500 ml",
    price: 720 + index * 12,
    moq: 2,
    stock: 60,
    supplierId: s.id,
    catalogOnly: true,
    demoListing: true,
    badge: "Demo shop",
  });
  return listings;
});
function migrateCatalogue(db) {
  db.reviews ||= [];
  if (!(db.catalogVersion >= 2)) {
    const retired = new Set([
      "p-rice",
      "p-oil",
      "p-juice",
      "p-milk",
      "p-lentil",
      "p-biscuit",
      "p-water",
      "p-soap",
    ]);
    // Keep old IDs and order references intact; only retire the old sample listings.
    for (const product of db.products)
      if (retired.has(product.id)) product.active = false;
    for (const supplier of suppliers)
      if (!db.suppliers.some((s) => s.id === supplier.id))
        db.suppliers.push(structuredClone(supplier));
    for (const product of products)
      if (!db.products.some((p) => p.id === product.id))
        db.products.push(structuredClone(product));
    db.catalogVersion = 2;
  }
  // Backfill seed photography without overwriting supplier edits or commerce data.
  if (!(db.catalogPhotoVersion >= 1)) {
    for (const source of products) {
      const target = db.products.find((p) => p.id === source.id && p.seeded);
      if (target && !target.image && source.image) target.image = source.image;
    }
    db.catalogPhotoVersion = 1;
  }
  if (!(db.marketplaceVersion >= 1)) {
    for (const shop of demoShops)
      if (!db.suppliers.some((s) => s.id === shop.id))
        db.suppliers.push(structuredClone(shop));
    for (const source of products) {
      const target = db.products.find((p) => p.id === source.id && p.seeded);
      if (target) {
        target.familyId ||= source.id;
        target.variantKey ||= source.servingSize || source.pack;
        target.variantLabel ||= source.servingSize || source.pack;
      }
    }
    for (const p of shopProducts)
      if (!db.products.some((existing) => existing.id === p.id))
        db.products.push(structuredClone(p));
    const coordinates = {
      "s-bd-dhaka": [23.8103, 90.4125],
      "s-bd-fruit": [23.9999, 90.4203],
      "s-bd-daily": [23.6238, 90.5],
    };
    for (const s of db.suppliers)
      if (coordinates[s.id] && s.latitude == null) {
        [s.latitude, s.longitude] = coordinates[s.id];
        s.demoShop = true;
      }
    db.marketplaceVersion = 1;
  }
  if (!(db.catalogExpansionVersion >= 2)) {
    for (const source of products) {
      const target = db.products.find((p) => p.id === source.id);
      if (!target)
        db.products.push({
          ...structuredClone(source),
          familyId: source.id,
          variantKey: source.servingSize || source.pack,
          variantLabel: source.servingSize || source.pack,
        });
      else if (target.seeded) {
        for (const key of [
          "company",
          "flavor",
          "compositionNote",
          "packUnits",
          "format",
          "preparationNote",
        ])
          if (!target[key]) target[key] = source[key];
      }
    }
    db.catalogExpansionVersion = 2;
  }

  if (!(db.richContentVersion >= 1)) {
    const examples = [
      [
        "bd-mojo",
        "Demo review: a familiar cola to compare for a neighborhood shop restock.",
        5,
      ],
      [
        "bd-clemon",
        "Demo review: compare the lemon drink pack sizes and dealer minimums before ordering.",
        4,
      ],
      [
        "bd-frooto",
        "Demo review: the case details make planning a small shop order easier.",
        4,
      ],
      [
        "bd-nescafe",
        "Demo review: check jar sizes and preparation details when comparing coffee listings.",
        5,
      ],
      [
        "bd-milo",
        "Demo review: compare case prices and read the physical pack before choosing a drink mix.",
        4,
      ],
      [
        "bd-coke-original",
        "Demo review: helpful to see the can size and dealer stock together.",
        4,
      ],
    ];
    for (const [familyId, comment, rating] of examples) {
      const id = `sample-review-${familyId}`;
      if (!db.reviews.some((r) => r.id === id))
        db.reviews.push({
          id,
          familyId,
          buyerId: "seeded-example",
          author: "Sample customer",
          comment,
          rating,
          demo: true,
          seeded: true,
          verifiedPurchase: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
    }
    for (const shop of db.suppliers.filter((s) =>
      s.id.startsWith("s-cosmobit-"),
    )) {
      shop.deliveryNote ||=
        "Demo storefront. Agree on delivery area, timing and charges with the dealer before ordering.";
      shop.coverImage ||= "/images/stories/refresh.jpg";
    }
    db.richContentVersion = 1;
  }

  if (!(db.catalogVariantsVersion >= 1)) {
    for (const p of require("./variants.json"))
      if (!db.products.some((existing) => existing.id === p.id))
        db.products.push(structuredClone(p));
    db.catalogVariantsVersion = 1;
  }
}
module.exports = { suppliers, products, categories, migrateCatalogue };
