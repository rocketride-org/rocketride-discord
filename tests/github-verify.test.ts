import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContributorStore, type ContributorRecord } from '../github-verify';

const tmpStore = (): ContributorStore => new ContributorStore(join(mkdtempSync(join(tmpdir(), 'contrib-')), 'contributors.json'));

const rec = (over: Partial<ContributorRecord> = {}): ContributorRecord => ({
	discord_id: 'd1',
	github_id: 1001,
	github_login: 'octocat',
	verified_at: 1,
	merged_prs: 2,
	method: 'github-device-flow',
	...over,
});

test('store: a fresh pair has no claim conflict', () => {
	const s = tmpStore();
	assert.equal(s.claimConflict('d1', 1001), null);
});

test('store: upsert then lookup by either id', () => {
	const s = tmpStore();
	s.upsert(rec());
	assert.equal(s.byDiscordId('d1')?.github_login, 'octocat');
	assert.equal(s.byGithubId(1001)?.discord_id, 'd1');
	assert.equal(s.byDiscordId('nobody'), null);
	assert.equal(s.byGithubId(9999), null);
});

test('store: one Discord user cannot link a second GitHub account', () => {
	const s = tmpStore();
	s.upsert(rec());
	const conflict = s.claimConflict('d1', 2002);
	assert.equal(conflict?.kind, 'discord_linked');
	assert.equal(conflict?.existing.github_login, 'octocat');
});

test('store: one GitHub account cannot be claimed by a second Discord user', () => {
	const s = tmpStore();
	s.upsert(rec());
	const conflict = s.claimConflict('d2', 1001);
	assert.equal(conflict?.kind, 'github_claimed');
	assert.equal(conflict?.existing.discord_id, 'd1');
});

test('store: re-verifying the same pair is allowed (the re-check path)', () => {
	const s = tmpStore();
	s.upsert(rec());
	assert.equal(s.claimConflict('d1', 1001), null);
});

test('store: upsert is idempotent per Discord user', () => {
	const s = tmpStore();
	s.upsert(rec());
	s.upsert(rec({ merged_prs: 7 }));
	assert.equal(s.all().length, 1);
	assert.equal(s.byDiscordId('d1')?.merged_prs, 7);
});

test('store: records survive a reload from disk', () => {
	const path = join(mkdtempSync(join(tmpdir(), 'contrib-')), 'contributors.json');
	new ContributorStore(path).upsert(rec());
	const reopened = new ContributorStore(path);
	assert.equal(reopened.byGithubId(1001)?.discord_id, 'd1');
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))), ['records']);
});

test('store: a missing file reads as empty rather than throwing', () => {
	const s = new ContributorStore(join(mkdtempSync(join(tmpdir(), 'contrib-')), 'does-not-exist.json'));
	assert.deepEqual(s.all(), []);
});
