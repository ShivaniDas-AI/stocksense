/**
 * Where the app finds the StockSense server.
 *
 * Development: the ngrok tunnel in front of the Docker server on your laptop.
 * It is reachable from anywhere (Wi-Fi or mobile data) while Docker and ngrok
 * are running. The URL can also be changed inside the app under Settings,
 * which is what you do once the server moves to a permanent domain.
 */
export const DEFAULT_API_URL = "https://shiftless-uncle-occupier.ngrok-free.dev";

export const APP_NAME = "StockSense";
