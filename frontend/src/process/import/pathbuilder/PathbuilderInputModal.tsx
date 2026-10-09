import { Anchor, Button, Group, Modal, Stack, Text, TextInput, Title } from '@mantine/core';
import { useState } from 'react';

import { extractBuildId } from './fetch-pathbuilder-share';

export default function PathbuilderInputModal(props: {
  open: boolean;
  loading?: boolean;
  onAutomaticConfirm: (pathbuilderInput: string) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState('');
  const buildId = extractBuildId(input);

  return (
    <Modal
      opened={props.open}
      onClose={() => {
        if (!props.loading) props.onClose();
      }}
      title={<Title order={3}>Import from Pathbuilder 2e</Title>}
      zIndex={1000}
    >
      <Stack style={{ position: 'relative' }} gap={20}>
        <TextInput
          label='Pathbuilder share ID or link'
          placeholder='123456 or https://pathbuilder2e.com/launch.html?build=123456'
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
          disabled={props.loading}
          error={input.trim() && !buildId ? 'Could not find a numeric share ID in that link' : undefined}
          description={buildId && input.trim() !== buildId ? `Share ${buildId}` : undefined}
        />
        <Text fz='sm'>
          WG will load the shared character in an isolated backend browser, invoke Pathbuilder's official JSON export,
          and validate the export against the share before importing. No iframe, popup, browser extension, or userscript
          is required. This can take up to a minute; if Pathbuilder blocks automated access, the import will fail closed.
        </Text>
        <Text fz='sm'>
          <Anchor
            href='https://github.com/EvelynLimaB/wanderers-guide/blob/feature/pathbuilder-1to1-import/docs/pathbuilder-browser-export-bridge.md'
            target='_blank'
            rel='noreferrer'
          >
            How automatic import works
          </Anchor>
        </Text>
        <Group justify='flex-end' wrap='wrap'>
          <Button variant='default' disabled={props.loading} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            loading={props.loading}
            disabled={!buildId || Boolean(input.trim() && !buildId)}
            onClick={() => {
              if (!buildId) return;
              props.onAutomaticConfirm(input.trim());
            }}
          >
            Import automatically
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
