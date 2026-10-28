/**
 * A resolve hook for a child Node process that runs the TypeScript sources with Node's own type
 * stripping: the sources import `./x.js`, which is `./x.ts` on disk. Used by
 * `s3-child-connect.ts` only.
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const parent = context.parentURL;
      if (
        parent !== undefined &&
        specifier.startsWith('.') &&
        specifier.endsWith('.js')
      ) {
        const candidate = new URL(specifier.replace(/\.js$/, '.ts'), parent);
        if (existsSync(fileURLToPath(candidate))) {
          return nextResolve(candidate.href, context);
        }
      }
      throw error;
    }
  },
});
