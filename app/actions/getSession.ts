import prisma from "../db.server";

export const getSession = async (shop: string) => {
  try {
    const session = await prisma.session.findFirst({
      where: {
        shop: shop,
      },
    });

    return session;
  } catch (error) {
    console.error("Error fetching stores by user ID:", error);
    throw new Error("Could not fetch stores. Please try again.");
  }
};
