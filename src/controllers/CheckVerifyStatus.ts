// src/controllers/checkVerifyStatus.ts
import { Request, Response } from "express";
import axios from "axios";
import qs from "qs";

/**
 * GET /checkverifystatus?network=<red>&guid=<GUID>
 * Reenvía la consulta a Etherscan/BaseScan:
 *   module=contract
 *   action=checkverifystatus
 *   guid=<GUID>
 *   apikey=<APIKEY>
 */
export const checkVerifyStatus = async (req: Request, res: Response) => {
  console.log("checkVerifyStatus");

  try {
    const network = String(req.query.network || "").toLowerCase();
    const guid = String(req.query.guid || "");
    console.log(network, " guid", guid);

    if (!network || !guid) {
      res
        .status(400)
        .json({ error: "Faltan parámetros 'network' o 'guid' en la query" });
      return;
    }

    let apiUrl: string;
    let apiKey: string;
    console.log(network, " guid", guid);
    switch (network) {
      case "mainnet":
        apiUrl = "https://api.etherscan.io/api";
        apiKey = process.env.ETHERSCAN_API_KEY || "";
        break;

      case "base":
        apiUrl = "https://api.basescan.org/api";
        apiKey = process.env.BASESCAN_API_KEY || "";
        break;
      case "baseSepolia":
        apiUrl = "https://api-sepolia.basescan.org/api";
        apiKey = process.env.BASESCAN_API_KEY || "";
        break;
      case "basesepolia":
        apiUrl = "https://api-sepolia.basescan.org/api";
        apiKey = process.env.BASESCAN_API_KEY || "";
        break;
      default:
        res.status(400).json({ error: `Red no soportada: ${network}` });
        return;
    }

    if (!apiKey) {
      res
        .status(500)
        .json({ error: `No se encontró API KEY para la red "${network}"` });
      return;
    }

    const query = {
      apikey: apiKey,
      module: "contract",
      action: "checkverifystatus",
      guid: guid,
    };

    // Hacemos GET a la API (Content-Type no es necesario aquí)
    const response = await axios.get(apiUrl + "?" + qs.stringify(query), {
      timeout: 60000, // 60 segundos de timeout
    });
    console.log(response.data);

    // Devolvemos el JSON que retorna Etherscan/BaseScan
    res.status(200).json(response.data);
  } catch (err: any) {
    console.error("Error en checkVerifyStatus controller:", err);
    if (axios.isAxiosError(err) && err.response) {
      res.status(err.response.status || 500).json(err.response.data);
    } else {
      res.status(500).json({ error: err.message || "Error desconocido" });
    }
  }
};

export default checkVerifyStatus;
