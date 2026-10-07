import { Button, Group, Modal, Stack, Text, TextInput, Title } from '@mantine/core';
import { useState } from 'react';

import { extractBuildId } from './fetch-pathbuilder-share';

export default function PathbuilderInputModal(props: {
  open: boolean;
  onConfirm: (pathbuilderInput: string) => void;
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
          Custom items are imported as homebrew content.
        </Text>
        <Group justify='flex-end'>
          <Button variant='default' onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={!buildId}
            onClick={() => {
              if (!buildId) return;
              props.onConfirm(input.trim());
            }}
          >
            Import
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
