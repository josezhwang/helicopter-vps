/** The API on the same host the page came from (port 3002), so players opening the site by IP reach it too. */
export const API_URL: string = import.meta.env.VITE_API_URL || `${window.location.protocol}//${window.location.hostname}:3002`
