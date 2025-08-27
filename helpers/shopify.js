export async function shopifyFetch({ query, variables, store }) {
  const response = await fetch(`https://${process.env[`${store}_SHOPIFY_STORE_DOMAIN`]}/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': process.env[`${store}_SHOPIFY_STORE_ACCESS_TOKEN`],
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await response.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
};

export async function createStagedUpload({ documents, store }) {
  const mutation = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    input: documents.map(document=>{
      return {
        filename: `${document.url.split("/").at(-1).replaceAll("%", "_").trim()}`,
        mimeType: `application/${document.url.split("/").at(-1).split(".").at(-1)}`,
        resource: 'FILE',
        httpMethod: 'POST'
      }
    })
  };

  const data = await shopifyFetch({ query: mutation, variables, store });
  const result = data.stagedUploadsCreate;

  if (result.userErrors.length > 0) {
    throw new Error('stagedUploadsCreate error: ' + JSON.stringify(result.userErrors));
  }

  return result.stagedTargets;
};

export async function fetchS3FileBuffer({ s3Url }) {
  try {
    const res = await fetch(s3Url);
    return await res.arrayBuffer();
  } catch (error) {
    console.log("failed fetching file: ", s3Url.split("/").at(-1), error);
  }
};

export async function uploadToStagedUrl({ stagedTarget, fileBuffer }) {
  const formData = new FormData();
  stagedTarget.parameters.forEach(param => {
    formData.append(param.name, param.value);
  });
  formData.append('file', new Blob([fileBuffer]), 'file.pdf');

  const res = await fetch(stagedTarget.url, {
    method: 'POST',
    body: formData
  });

  if (!res.ok) {
    console.log("failed uploading file: ", stagedTarget.resourceUrl.split("/").at(-1));
    // throw new Error(`Staged upload failed with status ${res.status}`);
  }
};

export async function finalizeUpload({ stagedTargets, store }) {
  const mutation = `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          alt
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    files: stagedTargets.map(stagedTarget=>{
      return {
        originalSource: stagedTarget.resourceUrl,
        alt: `Uploaded ${store} File: ${stagedTarget.resourceUrl.split("/").at(-1)}`,
        contentType: "FILE"
      }
    })
  };

  const data = await shopifyFetch({ query: mutation, variables, store });
  const result = data.fileCreate;

  if (result.userErrors.length > 0) {
    throw new Error('fileCreate error: ' + JSON.stringify(result.userErrors));
  }

  return result.files;
};

export async function createProductAPI({ productData, store, metafields }) {
  // check if there are images in the product
  var product_images = null;
  if(productData.attributes.media.images.length > 0 && productData.attributes.media.images.filter(image=>image.big).length > 0)product_images = productData.attributes.media.images.filter(image=>image.big).map(image=>{
    return {
      originalSource: image.big,
      mediaContentType: 'IMAGE',
      alt: `Uploaded ${store} Image`
    }
  }).flat();

  // check if there are videos in the product
  var product_videos = null;
  if(productData.attributes.media.videos.length > 0)product_videos = productData.attributes.media.videos.map(video=>{
    return {
      originalSource: video.url,
      mediaContentType: 'VIDEO',
      alt: `Uploaded ${store} Video`,
    }
  });

  const create_product_mutation = `
    mutation CreateProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
      productCreate(product: $product, media: $media) {
        product {
          id
          title
          variants(first: 1) {
            nodes {
              id
              sku
              inventoryItem {
                id
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    product: {
      title: `${productData.attributes.name} - ${productData.id}`,
      status: productData.attributes.is_old ? "DRAFT" : "ACTIVE",
      descriptionHtml: productData.attributes.description
    }
  };

  if(product_images && product_images.length > 0)variables.media = product_images;

  if(product_videos && product_videos.length > 0)variables.media = variables.media.concat(product_videos);

  if(metafields && metafields.length > 0)variables.product.metafields = metafields;

  return shopifyFetch({ query: create_product_mutation, variables, store });
};

export async function deleteProductAPI({ productId, store }) {
  const mutation = `
    mutation {
      productDelete(input: {id: "${productId}"}) {
        deletedProductId
        userErrors {
          field
          message
        }
      }
    }
  `;

  return shopifyFetch({ query: mutation, store });
};

export const uploadImagesToShopify = async ({ images, store }) => {
  const mutation = `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          url
          alt
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    files: images.map(image=>{
      return {
        originalSource: image.url,
        contentType: 'IMAGE',
        alt: `Uploaded ${store} Image`,
      }
    })
  };

  const data = await shopifyFetch({ mutation, variables, store });
  const result = data.fileCreate;

  if (result.userErrors.length > 0) {
    throw new Error('imageCreate error: ' + JSON.stringify(result.userErrors));
  }

  return result.files;
};

export const publishablePublish = async ({ id, publication, store }) => {
  const mutation = `
    mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable {
          availablePublicationsCount {
            count
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    id,
    input: {
      publicationId: publication.id
    }
  };

  return shopifyFetch({ query: mutation, variables, store });
};

export const getAllPublications = async ({ store }) => {
  const query = `
    query getPublications {
      publications(first: 250) {
        nodes {
          id
          name
        }
      }
    }
  `;

  return shopifyFetch({ query, store });
};

export async function updateMetafields({ metafields, store }) {
  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          key
          value
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    metafields
  };

  const data = await shopifyFetch({ query: mutation, variables, store });
  const result = data.metafieldsSet;

  if (result.userErrors.length > 0)return {
    status: "error",
    errors: result.userErrors
  };

  return {
    status: "success"
  };
};

export const uploadS3FilesToShopify = async ({ documents, store }) => {
  try {
    //Step 1: get staged (temporary) upload url for step 2
    // console.log('1️⃣ Creating staged upload...');
    const stagedTargets = await createStagedUpload({ documents, store });

    //Step 2 + 3 : get the file from S3 then upload the file to the returned url from step 1
    // console.log('2️⃣ + 3️⃣ get the file from S3 then upload the file to the returned url from step 1...');
    await Promise.all(documents.map(async (document)=>{
      const document_name = document.url.split("/").at(-1).replaceAll("%", "_").trim();
      const stagedTarget = stagedTargets.find(stagedTarget=>stagedTarget.resourceUrl.includes(`/${document_name}`))

      if(stagedTarget){
        //Step 2
        const fileBuffer = await fetchS3FileBuffer({ s3Url: document.url });

        //Step 3
        if(fileBuffer)await uploadToStagedUrl({ stagedTarget, fileBuffer });
      };
    }));

    //Step 4: upload file to Shopify using the return resourceUrl from step 1
    // console.log('4️⃣ Finalizing upload with fileCreate...');
    const files = await finalizeUpload({ stagedTargets, store });
    
    return {
      status: "success",
      error: null,
      files
    };
  } catch (error) {
    return {
      status: "error",
      error,
      files: []
    };
  }
};

export const collectionUpdate = async ({ data, store, feature, record }) => {
  var mutation;

  switch (feature) {
    case "updateCollectionTitle":
      mutation = `
        mutation CollectionUpdate($input: CollectionInput!) {
          collectionUpdate(input: $input) {
            collection {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      break;
    default:
      mutation = `
        mutation CollectionUpdate($input: CollectionInput!) {
          collectionUpdate(input: $input) {
            collection {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      break;
  };

  const variables = {
    input: data
  };

  const result = await shopifyFetch({ query: mutation, variables, store });

  if(result.collectionUpdate.userErrors.length > 0)return {
    status: "error",
    record,
    errors: result.collectionUpdate.userErrors
  };

  return {
    status: "success"
  }
};