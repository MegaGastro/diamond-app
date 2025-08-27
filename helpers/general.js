import fs from 'fs';
import path from 'path';

//return an array of unique items (no duplicates)
export const removeArrayDuplicates = (arr) => {
  return arr.filter((item,index) => arr.indexOf(item) === index);
};

//split array into an array of equal-size smaller arrays
export const chunkArray = (array, chunkSize) => {
  const numberOfChunks = Math.ceil(array.length / chunkSize)

  return [...Array(numberOfChunks)]
  .map((value, index) => {
      return array.slice(index * chunkSize, (index + 1) * chunkSize)
  })
};

export const logRecordToFile = ({ records, filePath }) => {
  var valid_file_path = filePath;
  const file_full_name = path.basename(valid_file_path);
  const file_extension = path.extname(valid_file_path);
  const file_name = file_full_name.split("_")[0];
  var file_number = file_full_name.split(".")[0].split("_").at(-1);
  
  // Initialize file if it doesn't exist
  if (!fs.existsSync(valid_file_path)) {
    fs.writeFileSync(valid_file_path, JSON.stringify([]), 'utf8');
  };

  // Read current data
  const fileContent = fs.readFileSync(valid_file_path, 'utf8');
  var jsonData = JSON.parse(fileContent);

  if(jsonData.length >= 51){
    //create new file with increment number if the current file content has reached maximum
    const updated_file_full_name = `${file_name}_${++file_number}${file_extension}`;
    valid_file_path = valid_file_path.replace(file_full_name, updated_file_full_name);
    jsonData = records;
  } else {
    jsonData = jsonData.concat(records);
  };

  // Write updated array back to file
  fs.writeFileSync(valid_file_path, JSON.stringify(jsonData, null, 2), 'utf8');
  console.log(`Added records to ${valid_file_path}`);
  return file_number;
};

export const logRecordToFileNoLimit = ({ records, filePath }) => {
  var valid_file_path = filePath;
  
  // Initialize file if it doesn't exist
  if (!fs.existsSync(valid_file_path)) {
    fs.writeFileSync(valid_file_path, JSON.stringify([]), 'utf8');
  };

  // Read current data
  const fileContent = fs.readFileSync(valid_file_path, 'utf8');
  var jsonData = JSON.parse(fileContent);
  
  jsonData = jsonData.concat(records);

  // Write updated array back to file
  fs.writeFileSync(valid_file_path, JSON.stringify(jsonData, null, 2), 'utf8');
  console.log(`Added records to ${valid_file_path}`);
};

export const readRecordFromFile = ({ filePath }) => {
  const rawData = fs.readFileSync(filePath);
  const jsonData = JSON.parse(rawData);
  return jsonData;
};

export const deleteFile = async ({ filePath }) => {
  try {
    fs.unlink(filePath);
    console.log('File deleted successfully');
  } catch (err) {
    console.error('Error deleting file:', err);
  }
}

export const findDuplicates = (array) => {
  const seen = {};
  const duplicates = [];

  for (let value of array) {
    if (seen[value]) {
      duplicates.push(value);
    } else {
      seen[value] = true;
    }
  }

  return [...new Set(duplicates)]; // removes repeated duplicates
}

export const handleize = (str) => {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}0-9\s\-+]/gu, '')  // Keep all Unicode letters, digits, spaces, hyphens, plus
    .replace(/\s+/g, '-')               // Replace spaces with hyphens
    .replace(/-+/g, '-');               // Collapse multiple hyphens
};