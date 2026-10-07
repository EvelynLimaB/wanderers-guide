// @ts-ignore
import { serve } from 'std/server';
import { connect, getPublicUser, upsertData, upsertResponseWrapper } from '../_shared/helpers.ts';

/**
 * Persists the raw Pathbuilder 2e share payload behind an import.
 *
 * Called twice per import: once with `id: -1` to record the payload before the
 * character is built (so a failed character creation still leaves provenance),
 * and once with the returned `id` to attach `character_id`.
 *
 * The row is owned by the caller; `user_id` is taken from the session token and
 * never from the body, so a client cannot write a snapshot onto another user.
 */
serve(async (req: Request) => {
  return await connect(req, async (client, body, token) => {
    const {
      id,
      character_id,
      build_id,
      source_url,
      format_version,
      character_data,
      custom_files,
      derived_data,
      unresolved,
    } = body as Record<string, any>;

    const user = await getPublicUser(client, token, { rejectAnonymous: true });
    if (!user) {
      return {
        status: 'error',
        message: 'User not found',
      };
    }

    if (!build_id && !id) {
      return {
        status: 'fail',
        data: { build_id: 'build_id is required when creating a row' },
      };
    }

    // Strip undefined keys so the update path (attaching character_id) only
    // touches the columns the caller actually sent. `.update()` with an explicit
    // undefined would otherwise risk clobbering the stored payload.
    const payload: Record<string, any> = { id, user_id: user.user_id };
    for (const [key, value] of Object.entries({
      character_id,
      build_id: build_id === undefined ? undefined : String(build_id),
      source_url,
      format_version,
      character_data,
      custom_files,
      derived_data,
      unresolved,
    })) {
      if (value !== undefined) payload[key] = value;
    }

    const { procedure, result } = await upsertData(client, 'pathbuilder_import', payload);

    return upsertResponseWrapper(procedure, result);
  });
});
