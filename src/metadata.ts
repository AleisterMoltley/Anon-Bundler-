import axios from "axios";
import { CONFIG } from "./config";
import { log, retry } from "./utils";

interface TokenMetadata {
  name: string;
  symbol: string;
  description: string;
  image: string;
}

export async function uploadMetadata(
  name: string,
  symbol: string,
  description: string,
  imageUrl: string
): Promise<string> {
  const metadata: TokenMetadata = { name, symbol, description, image: imageUrl };

  // Real Pinata upload if JWT is provided
  if (CONFIG.pinataJwt) {
    return retry(
      async () => {
        log.step("Uploading metadata to IPFS via Pinata...");

        const res = await axios.post(
          "https://api.pinata.cloud/pinning/pinJSONToIPFS",
          {
            pinataContent: metadata,
            pinataMetadata: {
              name: `${symbol}-metadata`,
            },
          },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${CONFIG.pinataJwt}`,
            },
            timeout: 30_000,
          }
        );

        const ipfsHash = res.data.IpfsHash;
        const uri = `https://gateway.pinata.cloud/ipfs/${ipfsHash}`;
        log.success(`Metadata uploaded: ${uri}`);
        return uri;
      },
      { retries: 2, label: "Pinata upload" }
    );
  }

  // No Pinata JWT — abort, don't use fake URI
  throw new Error(
    "PINATA_JWT is not set. Cannot upload metadata. " +
    "Set PINATA_JWT in .env or provide a pre-uploaded metadata URI."
  );
}
