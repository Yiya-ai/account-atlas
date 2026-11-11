// This build option changes disclosure text only; it does not expose the server.
export const serverTunnel = import.meta.env.VITE_ATLAS_DEPLOYMENT === 'ssh-tunnel';
export const publicHttps = import.meta.env.VITE_ATLAS_DEPLOYMENT === 'https';
export const serverStored = serverTunnel || publicHttps;
