/** Prints one OS-assigned free loopback port for a conformance process's exact OAuth callback. */
import { createServer } from "node:net";

const server = createServer();
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The loopback listener did not report a TCP port");
  }
  console.log(address.port);
  server.close();
});
