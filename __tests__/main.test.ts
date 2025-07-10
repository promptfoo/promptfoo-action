import {describe, test, expect} from '@jest/globals';

// Simple tests to verify the logic would work
describe('disable-comment feature', () => {
  test('should have disable-comment parameter in action.yml', async () => {
    const fs = require('fs');
    const yaml = require('js-yaml');
    const path = require('path');
    
    const actionYmlPath = path.join(__dirname, '..', 'action.yml');
    const actionYml = fs.readFileSync(actionYmlPath, 'utf8');
    const action = yaml.load(actionYml);
    
    expect(action.inputs).toHaveProperty('disable-comment');
    expect(action.inputs['disable-comment'].description).toBe('Disable posting comments to the PR');
    expect(action.inputs['disable-comment'].default).toBe('false');
    expect(action.inputs['disable-comment'].required).toBe(false);
  });

  test('main.ts should have conditional comment logic', async () => {
    const fs = require('fs');
    const path = require('path');
    
    const mainPath = path.join(__dirname, '..', 'src', 'main.ts');
    const mainContent = fs.readFileSync(mainPath, 'utf8');
    
    // Check that disableComment is read from input
    expect(mainContent).toContain("const disableComment: boolean = core.getBooleanInput('disable-comment'");
    
    // Check that comment posting is wrapped in a condition
    expect(mainContent).toContain('if (!disableComment) {');
    expect(mainContent).toContain('octokit.rest.issues.createComment');
  });

  test('README.md should document the new parameter', async () => {
    const fs = require('fs');
    const path = require('path');
    
    const readmePath = path.join(__dirname, '..', 'README.md');
    const readmeContent = fs.readFileSync(readmePath, 'utf8');
    
    // Check that disable-comment is documented
    expect(readmeContent).toContain('`disable-comment`');
    expect(readmeContent).toContain('Disable posting comments to the PR');
  });
});