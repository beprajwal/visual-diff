import { defineConfig } from 'vite';

/**
 * The runner allocates a port and passes it through `$PORT` (see .visual-diff/config.yaml), so the
 * only thing fixed here is the host: the report and the driver both talk to 127.0.0.1, and binding
 * to a public interface would make the fixture behave differently on CI than on a laptop.
 */
export default defineConfig({
  server: {
    host: '127.0.0.1',
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    strictPort: true,
  },
});
