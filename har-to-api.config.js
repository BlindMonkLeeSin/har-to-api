module.exports = {
  outPutDir: "./__mocks__/services/",
  apiFileExtensions: ".ts",
  template: (option) => {
    const { functionName, method, api, dataName } = option;
    return `import _ from 'lodash';
import { rest } from 'msw';

import ${dataName} from './get.json';

export const ${functionName} = (
  formatResponseData?: (
    responseData: typeof ${dataName}
  ) => typeof ${dataName}
) =>
  rest.${method}('${api}', (req, res, context) => {
    const data = _.isFunction(formatResponseData)
      ? formatResponseData(_.cloneDeep(${dataName}))
      : ${dataName};
    return res(context.json(data));
  });
${functionName}.data = ${dataName};

export default [${functionName}()];
  `;
  },
  harPath: "./htc-test.devops.hypers.cc.har",
  supportMethods: ["get", "post"],
  cover: {
    api: true,
    data: true,
  },
  dynamicApiList: ["/api/v1/dashboard/scan/:container-name/vulnerabilities"],
};
