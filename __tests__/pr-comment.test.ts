import {run, handleError} from '../src/pr-comment';
import * as core from '@actions/core';
import {expect, test} from '@jest/globals';

test('test runs', async () => {
  await run();
});

test('handleError calls core.setFailed with error message', () => {
  const error = new Error('Test error');
  const setFailedMock = jest.spyOn(core, 'setFailed');
  handleError(error);
  expect(setFailedMock).toHaveBeenCalledWith('Test error');
});
