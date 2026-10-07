import { react } from '@contrataflow/eslint-config/react';
import { storybook } from '@contrataflow/eslint-config/storybook';

export default [...react({ tsconfigRootDir: import.meta.dirname }), ...storybook()];
