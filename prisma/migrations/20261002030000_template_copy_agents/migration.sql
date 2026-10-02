-- A personal template copy's copilot is that artifact's own agent: listed
-- among its owner's agents, with their Backstory data attached. A guest copy's
-- copilot (an anonymous visitor's, run as the sender) is typed so that it is
-- never listed and never gets that data.

-- `type` is not part of the copilot lock, so guests can be re-typed in place.
UPDATE "agent_tasks" AS agent
SET "type" = 'guest_copilot'
FROM "artifacts" AS copy
WHERE agent."artifactTemplateCopyId" = copy."id"
  AND copy."guestDigest" IS NOT NULL;

-- Copilots made before this change carry the old instructions and no
-- integrations, and the lock trigger forbids changing either. Lift it for this
-- one statement: same binding, new instructions, Backstory shown as attached.
ALTER TABLE "agent_tasks" DISABLE TRIGGER artifact_template_agent_lock;
UPDATE "agent_tasks" AS agent
SET "objective" = 'You are the copilot for one personal artifact copy. Make requested changes to its HTML, CSS, JavaScript, TypeScript and Python using the bound artifact tools. Preserve working functionality and save validated versions. Answer questions from this copy, the user''s messages and — when a request needs facts the page does not hold (accounts, opportunities, people, activity) — the user''s own Backstory data through the Backstory tools, saying where each fact came from. Never invent numbers; when the user asks for demo or sample data, make it plainly fictional. You cannot access the original template, other artifacts, repository documents, other integrations, flows, credentials or configuration. Never claim to change settings or connect tools. Do not save variants as other artifacts. Use sandboxed code for computations on inline data only.',
    "description" = 'Copilot for your copy of "' || left(regexp_replace(copy."title", ' · my copy$', ''), 120) || '". Edits it and answers questions about it.',
    "metadata" = coalesce(agent."metadata", '{}'::jsonb)
      || jsonb_build_object('title', left(regexp_replace(copy."title", ' · my copy$', ''), 70) || ' · copilot', 'integrations', jsonb_build_array('Backstory'), 'icon', 'artifact')
FROM "artifacts" AS copy
WHERE agent."artifactTemplateCopyId" = copy."id"
  AND copy."guestDigest" IS NULL
  AND copy."userId" IS NOT NULL;
ALTER TABLE "agent_tasks" ENABLE TRIGGER artifact_template_agent_lock;
