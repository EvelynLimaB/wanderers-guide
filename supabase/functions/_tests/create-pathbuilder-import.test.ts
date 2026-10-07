// Covers create-pathbuilder-import: the canonical create-* pattern plus the two
// invariants that matter for this endpoint.
//   1. insert returns the row, JSend success.
//   2. user_id in the body is IGNORED; ownership always comes from the session
//      token, so a caller cannot attach a snapshot to another user.
//   3. a missing build_id is the client's fault, so it returns fail, not error.
//   4. the update path attaches character_id and leaves the stored payload intact.
//   5. RLS: the row is invisible to a different authenticated user, even though
//      the character it points at may be public.

import { assert, assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';
import { ANON_KEY, admin, callFunction, seed, stackUnavailable } from './seed.ts';

const SUPABASE_URL =
  Deno.env.get('PUBLIC_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL') ?? 'http://127.0.0.1:54321';

const skip = stackUnavailable();

const payload = {
  build_id: '1596127',
  source_url: 'https://pathbuilder2e.com/app.html?emailedBuildID=1596127',
  format_version: '121',
  character_data: { characterName: 'Test Import', characterLevel: 20 },
  custom_files: [{ type: 3, json: '{"name":"Test Blade"}', uniqueIdentifier: 'x' }],
  derived_data: null,
  unresolved: [{ kind: 'armor', ref: 'none', reason: 'no armorName' }],
};

async function createStranger(): Promise<{ userId: string; jwt: string }> {
  const email = `pb-stranger-${crypto.randomUUID().slice(0, 8)}@wanderersguide.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: 'test1234',
    email_confirm: true,
  });
  if (error || !data?.user) throw error ?? new Error('failed to create stranger');
  const { data: session, error: sessionError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (sessionError) throw sessionError;
  return { userId: data.user.id, jwt: session?.properties?.action_link ?? '' };
}

Deno.test({
  name: 'create-pathbuilder-import: inserts a snapshot and returns the row',
  ignore: skip,
  async fn() {
    const { userId, jwt } = await seed();

    const result = await callFunction('create-pathbuilder-import', { id: -1, ...payload }, { token: jwt });
    assertEquals(result.status, 200);
    assertEquals(result.body?.status, 'success');

    const row = result.body?.data;
    assert(row?.id, 'expected an id on the new row');
    assertEquals(row.build_id, '1596127');
    assertEquals(row.format_version, '121');
    assertEquals(row.user_id, userId, 'user_id must come from the session token');
    assertEquals(row.character_data?.characterName, 'Test Import');
    assertEquals(row.custom_files?.length, 1);
    assertEquals(row.unresolved?.length, 1);

    await admin.from('pathbuilder_import').delete().eq('id', row.id);
  },
});

Deno.test({
  name: 'create-pathbuilder-import: ignores a user_id supplied in the body',
  ignore: skip,
  async fn() {
    const { userId, jwt } = await seed();

    const result = await callFunction(
      'create-pathbuilder-import',
      { id: -1, ...payload, user_id: '00000000-0000-0000-0000-000000000000' },
      { token: jwt }
    );
    assertEquals(result.body?.status, 'success');
    assertEquals(
      result.body?.data?.user_id,
      userId,
      'a body-supplied user_id must never override the token identity'
    );

    await admin.from('pathbuilder_import').delete().eq('id', result.body.data.id);
  },
});

Deno.test({
  name: 'create-pathbuilder-import: missing build_id is a client fault (fail, not error)',
  ignore: skip,
  async fn() {
    const { jwt } = await seed();

    const result = await callFunction(
      'create-pathbuilder-import',
      { id: -1, character_data: { characterName: 'No Id' } },
      { token: jwt }
    );
    assertEquals(result.body?.status, 'fail');
    assert(!result.body?.message, 'a fail response carries per-field data, not a server message');
  },
});

Deno.test({
  name: 'create-pathbuilder-import: update path attaches character_id and keeps the payload',
  ignore: skip,
  async fn() {
    const { jwt } = await seed();

    const created = await callFunction('create-pathbuilder-import', { id: -1, ...payload }, { token: jwt });
    const id = created.body?.data?.id;
    assert(id, 'expected an id from the insert');

    const updated = await callFunction('create-pathbuilder-import', { id, character_id: 424242 }, { token: jwt });
    assertEquals(updated.body?.status, 'success');
    assertEquals(updated.body?.data, true, 'the update path returns true, not a row');

    const { data: stored } = await admin.from('pathbuilder_import').select('*').eq('id', id).single();
    assertEquals(stored?.character_id, 424242);
    // The point of the second call is that it must not clobber the snapshot.
    assertEquals(stored?.build_id, '1596127');
    assertEquals(stored?.character_data?.characterName, 'Test Import');
    assertEquals(stored?.custom_files?.length, 1);

    await admin.from('pathbuilder_import').delete().eq('id', id);
  },
});

Deno.test({
  name: 'create-pathbuilder-import: RLS hides the row from another user',
  ignore: skip,
  async fn() {
    const { jwt } = await seed();
    const created = await callFunction('create-pathbuilder-import', { id: -1, ...payload }, { token: jwt });
    const id = created.body?.data?.id;
    assert(id, 'expected an id from the insert');

    const stranger = await createStranger();
    // A client carrying the stranger's JWT, exactly the way connect() builds one.
    const strangerClient = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${stranger.jwt}` } },
    });
    const { data: visible } = await strangerClient.from('pathbuilder_import').select('id').eq('id', id);
    assertEquals(visible?.length ?? 0, 0, 'another user must not be able to read the snapshot');

    await admin.from('pathbuilder_import').delete().eq('id', id);
    await admin.auth.admin.deleteUser(stranger.userId);
  },
});
