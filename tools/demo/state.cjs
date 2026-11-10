// Explicit demo importer/test fixture. Never imported by the deployed API.
const seed = require("./seed.cjs");
module.exports = () => {
  const state = {
    suppliers: structuredClone(seed.suppliers),
    products: structuredClone(seed.products),
    users: [],
    orders: [],
    quotes: [],
    conversations: [],
    reviews: [],
    addresses: [],
  };
  seed.migrateCatalogue(state);
  return state;
};
