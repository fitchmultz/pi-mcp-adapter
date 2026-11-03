/** Separate process that merges the metadata cache envelope given as its JSON argument. */
import { projectMetadataCache } from "../../metadata-cache-format.ts";
import { saveMetadataCache } from "../../metadata-cache.ts";

const input: unknown = JSON.parse(process.argv[2] ?? "");
const cache = projectMetadataCache(input);
if (cache === null) {
  throw new Error("Expected a metadata cache envelope argument");
}
saveMetadataCache(cache);
