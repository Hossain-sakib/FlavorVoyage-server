const { MongoClient } = require("mongodb");
let connection;
function mongoStoreFromCollection(collection) {
  return {
    async deleteTemporary(key) {
      if (!/^restore-drill-[0-9a-f-]{36}$/.test(key))
        throw Error("Only temporary drill records can be deleted.");
      await collection.deleteOne({ _id: key });
    },
    async getWithMetadata(key) {
      const record = await collection.findOne({ _id: key });
      return record
        ? { data: record.data, etag: String(record.revision) }
        : null;
    },
    async setJSON(key, data, condition) {
      if (condition.onlyIfNew) {
        try {
          await collection.insertOne({ _id: key, revision: 1, data });
          return { modified: true, etag: "1" };
        } catch (error) {
          if (error.code === 11000) return { modified: false };
          throw error;
        }
      }
      const revision = Number(condition.onlyIfMatch);
      if (!Number.isSafeInteger(revision))
        throw Error("A valid workspace revision is required.");
      const result = await collection.replaceOne(
        { _id: key, revision },
        { _id: key, revision: revision + 1, data },
      );
      return {
        modified: result.modifiedCount === 1,
        etag: String(revision + 1),
      };
    },
  };
}
async function getMongoStore() {
  if (!process.env.MONGODB_URI)
    throw Error("MongoDB configuration is missing.");
  if (!connection) {
    const client = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: 5,
      ignoreUndefined: true,
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      readConcern: { level: "majority" },
      writeConcern: { w: "majority", wtimeoutMS: 10000 },
    });
    connection = client.connect().catch((error) => {
      connection = undefined;
      throw error;
    });
  }
  const client = await connection;
  return mongoStoreFromCollection(
    client
      .db(process.env.MONGODB_DB || undefined)
      .collection("workspace_state"),
  );
}
module.exports = { getMongoStore, mongoStoreFromCollection };
