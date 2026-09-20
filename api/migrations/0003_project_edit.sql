-- Adds a JSONB column storing a project's full editable structure
-- (clips + captions) so it can be resumed after a refresh or reopened
-- from a different session. Video bytes are never stored here — they
-- stay client-side (see frontend IndexedDB video cache).
alter table shorts.projects add column if not exists edit jsonb;
