import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastMCP } from 'fastmcp';
import { destructiveDisabled } from './destructiveGuard.js';
import { registerAllTools } from './index.js';

function collectToolNames() {
  const toolNames: string[] = [];
  const server = {
    addTool: (tool: { name: string }) => {
      toolNames.push(tool.name);
    },
  } as unknown as FastMCP;

  registerAllTools(server);
  return toolNames;
}

describe('destructiveDisabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is disabled by default', () => {
    expect(destructiveDisabled()).toBe(false);
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on'])('treats %s as enabled', (value) => {
    vi.stubEnv('DISABLE_DESTRUCTIVE_TOOLS', value);
    expect(destructiveDisabled()).toBe(true);
  });

  it('ignores non-truthy values', () => {
    vi.stubEnv('DISABLE_DESTRUCTIVE_TOOLS', '0');
    expect(destructiveDisabled()).toBe(false);
  });
});

describe('destructive tool registration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('registers destructive tools by default', () => {
    const toolNames = collectToolNames();

    expect(toolNames).toEqual(
      expect.arrayContaining(['deleteFile', 'trashMessage', 'deleteEvent'])
    );
  });

  it('hides delete and trash tools when disabled', () => {
    vi.stubEnv('DISABLE_DESTRUCTIVE_TOOLS', 'true');
    const toolNames = collectToolNames();

    expect(toolNames).not.toEqual(
      expect.arrayContaining([
        'deleteRange',
        'deleteTableRows',
        'deleteComment',
        'deleteFile',
        'deleteSheet',
        'deleteConditionalFormatting',
        'deleteTable',
        'deleteChart',
        'deleteSheetsComment',
        'trashMessage',
        'deleteDraft',
        'deleteEvent',
      ])
    );
    expect(toolNames).toEqual(expect.arrayContaining(['readDocument', 'readSpreadsheet']));
  });
});
