import { Anchor, Button, Group, Modal, Stack, Text, TextInput, Title } from '@mantine/core';
import { useState } from 'react';

import { extractBuildId } from './fetch-pathbuilder-share';

export default function PathbuilderInputModal(props: {
  open: boolean;
  onConfirm: (pathbuilderInput: string) => void;
  onBrowserConfirm: (pathbuilderInput: string) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState('');
  const buildId = extractBuildId(input);

  return (
    <Modal
      opened={props.open}
      onClose={() => props.onClose()}
      title={<Title order={3}>Import from Pathbuilder 2e</Title>}
      zIndex={1000}
    >
      <Stack style={{ position: 'relative' }} gap={20}>
        <TextInput
          label='Pathbuilder build ID or share link'
          placeholder='123456 or https://pathbuilder2e.com/app.html?emailedBuildID=123456'
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
          error={input.trim() && !buildId ? 'Could not find a build ID in that' : undefined}
          description={buildId && input.trim() !== buildId ? `Build ${buildId}` : undefined}
        />
        <Text fs='italic' fz='sm'>
          Browser-assisted import obtains Pathbuilder-calculated stats and validates the character identity.
          Install the helper directly from this WG instance first. A userscript manager such as Violentmonkey
          is required by browser security; WG cannot install it silently.
        </Text>
        <Group gap='xs'>
          <Anchor
            href='/pathbuilder-wg-bridge.user.js'
            target='_blank'
            rel='noreferrer'
          >
            Install helper from this WG
          </Anchor>
          <Text c='dimmed' fz='sm'>·</Text>
          <Anchor
            href='https://github.com/EvelynLimaB/wanderers-guide/blob/feature/pathbuilder-1to1-import/docs/pathbuilder-browser-export-bridge.md'
            target='_blank'
            rel='noreferrer'
          >
            Instructions
          </Anchor>
        </Group>
        <Group justify='flex-end' wrap='wrap'>
          <Button variant='default' onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant='default'
            disabled={!buildId}
            onClick={() => {
              if (!buildId) return;
              props.onConfirm(input.trim());
            }}
          >
            Share only
          </Button>
          <Button
            disabled={!buildId}
            onClick={() => {
              if (!buildId) return;
              props.onBrowserConfirm(input.trim());
            }}
          >
            Import via browser
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
