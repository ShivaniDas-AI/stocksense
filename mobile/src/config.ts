/**
 * Where the app finds the StockSense server.
 *
 * Development: the ngrok tunnel in front of the Docker server on your laptop.
 * It is reachable from anywhere (Wi-Fi or mobile data) while Docker and ngrok
 * are running. The URL can also be changed inside the app under Settings,
 * which is what you do once the server moves to a permanent domain.
 */
import { Platform } from "react-native";

const NGROK_URL = "https://shiftless-uncle-occupier.ngrok-free.dev";
const LOCAL_URL = "http://localhost:3000";

// The web build runs on the same PC as the Docker server, so it talks to it
// directly and skips the tunnel. Phones go through ngrok.
export const DEFAULT_API_URL = Platform.OS === "web" ? LOCAL_URL : NGROK_URL;

export const APP_NAME = "StockSense";
