import { Anchor, Button, Group, Modal, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useEffect, useState } from 'react';

import { extractBuildId } from './fetch-pathbuilder-share';
import type { PathbuilderInteractiveImportResult } from './import-from-pathbuilder';
import type { PathbuilderSelectionPrompt } from './pathbuilder-share-importer';

export default function PathbuilderInputModal(props: {
  open: boolean;
  loading?: boolean;
  onConfirm: (
    pathbuilderInput: string,
    jsonExportId: string,
    selectionOverrides: Record<string, string>
  ) => Promise<PathbuilderInteractiveImportResult>;
  onClose: () => void;
}) {
  const [input, setInput] = useState('');
  const [jsonExportId, setJsonExportId] = useState('');
  const [manualSelections, setManualSelections] = useState<Record<string, string>>({});
  const [selectionPrompt, setSelectionPrompt] = useState<PathbuilderSelectionPrompt | null>(null);
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null);
  const buildId = extractBuildId(input);
  const validExportId = /^\d{1,12}$/.test(jsonExportId.trim());
  const selectedOption = selectionPrompt?.options.find((option) => option.value === selectedChoice);

  useEffect(() => {
    if (!props.open) {
      setInput('');
      setJsonExportId('');
      setManualSelections({});
      setSelectionPrompt(null);
      setSelectedChoice(null);
    }
  }, [props.open]);

  const close = () => {
    if (props.loading) return;
    setInput('');
    setJsonExportId('');
    setManualSelections({});
    setSelectionPrompt(null);
    setSelectedChoice(null);
    props.onClose();
  };

  const confirm = async () => {
    if (!buildId || !validExportId) return;

    const answers = { ...manualSelections };
    if (selectionPrompt) {
      if (!selectedChoice || !selectionPrompt.options.some((option) => option.value === selectedChoice)) return;
      answers[selectionPrompt.key] = selectedChoice;
    }

    const result = await props.onConfirm(input.trim(), jsonExportId.trim(), answers);
    setManualSelections(answers);

    if (result.status === 'selection-required') {
      setSelectionPrompt(result.selection);
      const previousChoice = answers[result.selection.key];
      setSelectedChoice(
        previousChoice && result.selection.options.some((option) => option.value === previousChoice)
          ? previousChoice
          : null
      );
      return;
    }

    if (result.status === 'failed') {
      setSelectionPrompt(null);
      setSelectedChoice(null);
    }
  };

  return (
    <Modal
      opened={props.open}
      onClose={close}
      title={<Title order={3}>Import from Pathbuilder 2e</Title>}
      zIndex={1000}
    >
      <Stack style={{ position: 'relative' }} gap={16}>
        <TextInput
          label='Pathbuilder share ID or link'
          placeholder='123456 or https://pathbuilder2e.com/launch.html?build=123456'
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
          disabled={props.loading || Boolean(selectionPrompt)}
          error={input.trim() && !buildId ? 'Could not find a numeric share ID in that link' : undefined}
          description={buildId && input.trim() !== buildId ? `Share ID: ${buildId}` : undefined}
        />
        <TextInput
          label='Official JSON export ID'
          placeholder='The number shown after Export → Export JSON'
          value={jsonExportId}
          onChange={(event) => setJsonExportId(event.currentTarget.value)}
          disabled={props.loading || Boolean(selectionPrompt)}
          error={jsonExportId.trim() && !validExportId ? 'Enter the numeric export ID' : undefined}
        />
        {!selectionPrompt && (
          <>
            <Text fz='sm'>
              Open the same character in Pathbuilder, choose Export → Export JSON, and copy the numeric ID it generates.
              Enter that ID alongside the share ID. They are different identifiers.
            </Text>
            <Text fz='sm'>
              WG checks all required operation choices before creating the character. If a choice is missing from the
              shared build, it will ask you to select a valid option first.
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
          </>
        )}
        {selectionPrompt && (
          <Stack gap={8}>
            <Text fw={700}>Required choice missing: {selectionPrompt.title}</Text>
            <Text size='sm'>
              Character level {selectionPrompt.level}. Choose an option to continue the pre-import checks. The character
              will not be created until all required choices have been resolved.
            </Text>
            {selectionPrompt.options.length > 0 ? (
              <>
                <Select
                  label='Choose an option'
                  placeholder='Select an option'
                  searchable
                  clearable
                  data={selectionPrompt.options.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  value={selectedChoice}
                  onChange={setSelectedChoice}
                  disabled={props.loading}
                />
                {selectedOption?.description && <Text size='sm'>{selectedOption.description}</Text>}
              </>
            ) : (
              <Text c='red' size='sm'>
                Wanderer’s Guide returned no eligible options for this required choice, and no compatible fallback
                choices were found in the loaded content. Import is blocked until the relevant content options are
                available; no value will be guessed.
              </Text>
            )}
          </Stack>
        )}
        <Group justify='flex-end' wrap='wrap'>
          <Button variant='default' disabled={props.loading} onClick={close}>
            Cancel
          </Button>
          <Button
            loading={props.loading}
            disabled={
              !buildId ||
              !validExportId ||
              Boolean(selectionPrompt && (!selectionPrompt.options.length || !selectedChoice))
            }
            onClick={() => void confirm()}
          >
            {selectionPrompt ? 'Confirm choice and continue' : 'Check choices and import'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
