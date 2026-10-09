import { Anchor, Box, Button, Group, Modal, Stack, Text, TextInput, Title } from '@mantine/core';
import { useRef, useState } from 'react';

import { extractBuildId } from './fetch-pathbuilder-share';

const PATHBUILDER_ORIGIN = 'https://pathbuilder2e.com';

export default function PathbuilderInputModal(props: {
  open: boolean;
  onConfirm: (pathbuilderInput: string) => void;
  onBrowserConfirm: (pathbuilderInput: string, iframe?: HTMLIFrameElement) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState('');
  const [iframeBuildId, setIframeBuildId] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const buildId = extractBuildId(input);
  const frameIsForCurrentBuild = Boolean(buildId && iframeBuildId === buildId);

  return (
    <Modal
      opened={props.open}
      onClose={() => props.onClose()}
      title={<Title order={3}>Import from Pathbuilder 2e</Title>}
      zIndex={1000}
      size='xl'
    >
      <Stack style={{ position: 'relative' }} gap={16}>
        <TextInput
          label='Pathbuilder build ID or share link'
          placeholder='123456 or https://pathbuilder2e.com/app.html?emailedBuildID=123456'
          value={input}
          onChange={(event) => {
            setInput(event.currentTarget.value);
            setIframeBuildId(null);
          }}
          error={input.trim() && !buildId ? 'Could not find a build ID in that' : undefined}
          description={buildId && input.trim() !== buildId ? `Build ${buildId}` : undefined}
        />
        <Text fz='sm'>
          The iframe method needs the WG Pathbuilder helper (Violentmonkey or a compatible userscript manager).
          Pathbuilder may block embedding; use the separate-window option if the frame is refused or stays blank.
        </Text>
        <Group gap='xs'>
          <Anchor href='/pathbuilder-wg-bridge.user.js' target='_blank' rel='noreferrer'>
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

        {frameIsForCurrentBuild && iframeBuildId && (
          <Box>
            <Text size='sm' mb={6}>Pathbuilder character preview</Text>
            <Box
              style={{
                overflow: 'hidden',
                border: '1px solid var(--mantine-color-default-border)',
                borderRadius: 'var(--mantine-radius-md)',
              }}
            >
              <iframe
                ref={iframeRef}
                title='Pathbuilder character'
                src={`${PATHBUILDER_ORIGIN}/launch.html?build=${encodeURIComponent(iframeBuildId)}`}
                style={{ display: 'block', width: '100%', height: 440, border: 0, background: 'white' }}
                allow='clipboard-read; clipboard-write'
              />
            </Box>
          </Box>
        )}

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
          {!frameIsForCurrentBuild ? (
            <Button
              disabled={!buildId}
              onClick={() => setIframeBuildId(buildId)}
            >
              Load in iframe
            </Button>
          ) : (
            <Button
              disabled={!buildId}
              onClick={() => {
                if (!buildId || !iframeRef.current) return;
                props.onBrowserConfirm(input.trim(), iframeRef.current);
              }}
            >
              Import via iframe
            </Button>
          )}
          <Button
            disabled={!buildId}
            onClick={() => props.onBrowserConfirm(input.trim())}
          >
            Import in separate window
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
