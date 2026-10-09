import { Anchor, Button, Group, Modal, Stack, Text, TextInput, Title } from '@mantine/core';
import { useState } from 'react';

import { extractBuildId } from './fetch-pathbuilder-share';

export default function PathbuilderInputModal(props: {
  open: boolean;
  loading?: boolean;
  onConfirm: (pathbuilderInput: string, jsonExportId: string) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState('');
  const [jsonExportId, setJsonExportId] = useState('');
  const buildId = extractBuildId(input);
  const validExportId = /^\d{1,12}$/.test(jsonExportId.trim());

  return (
    <Modal
      opened={props.open}
      onClose={() => {
        if (!props.loading) props.onClose();
      }}
      title={<Title order={3}>Import from Pathbuilder 2e</Title>}
      zIndex={1000}
    >
      <Stack style={{ position: 'relative' }} gap={16}>
        <TextInput
          label='Pathbuilder share ID or link'
          placeholder='123456 or https://pathbuilder2e.com/launch.html?build=123456'
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
          disabled={props.loading}
          error={input.trim() && !buildId ? 'Could not find a numeric share ID in that link' : undefined}
          description={buildId && input.trim() !== buildId ? `Share ID: ${buildId}` : undefined}
        />
        <TextInput
          label='Official JSON export ID'
          placeholder='The number shown after Export → Export JSON'
          value={jsonExportId}
          onChange={(event) => setJsonExportId(event.currentTarget.value)}
          disabled={props.loading}
          error={jsonExportId.trim() && !validExportId ? 'Enter the numeric export ID' : undefined}
        />
        <Text fz='sm'>
          Pathbuilder is blocking the server-side automatic browser with an anti-bot challenge. To continue without
          bypassing that protection, open the same character in Pathbuilder, choose Export → Export JSON, and copy the
          numeric ID it generates. Enter that export ID here along with the character's share ID. They are different IDs.
        </Text>
        <Text fz='sm'>
          WG retrieves the share and calculated JSON separately, then compares the character identity before import.
          If the export cannot be fetched, the IDs do not match, or a required selection cannot be resolved, the import
          stops rather than guessing.
        </Text>
        <Text fz='sm'>
          <Anchor href='https://www.pathbuilder2e.com/beta/app.html' target='_blank' rel='noreferrer'>
            Open Pathbuilder 2e
          </Anchor>
          {' · '}
          <Anchor
            href='https://github.com/EvelynLimaB/wanderers-guide/blob/feature/pathbuilder-1to1-import/docs/pathbuilder-browser-export-bridge.md'
            target='_blank'
            rel='noreferrer'
          >
            Import instructions
          </Anchor>
        </Text>
        <Group justify='flex-end' wrap='wrap'>
          <Button variant='default' disabled={props.loading} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            loading={props.loading}
            disabled={!buildId || !validExportId}
            onClick={() => {
              if (!buildId || !validExportId) return;
              props.onConfirm(input.trim(), jsonExportId.trim());
            }}
          >
            Import with JSON export
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
